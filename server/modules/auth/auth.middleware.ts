// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import jwt from 'jsonwebtoken';

import { IS_PLATFORM } from '@/shared/utils.js';

import { userDb, appConfigDb } from '../database/index.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};


// 滑动宽限刷新：签名有效、且过期未超过宽限期的 token 仍可换取新 token。
// 场景：桌面端 OS 睡眠/渲染进程节流错过半程刷新定时器 → token 过期 →
// 原本 /refresh 自己也要求有效 token，死锁成只能重新登录。
const REFRESH_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 过期后 7 天内可刷新

/** 纯函数：解码后的 token 是否仍在刷新宽限期内（供单测）。 */
const isWithinRefreshGrace = (decoded, nowMs = Date.now()) => {
    if (!decoded || typeof decoded.exp !== 'number') {
        return false;
    }
    return nowMs <= decoded.exp * 1000 + REFRESH_GRACE_MS;
};

const authenticateRefresh = (req, res, next) => {
    // Platform mode: use single database user
    if (IS_PLATFORM) {
        try {
            const user = userDb.getFirstUser();
            if (!user) {
                return res.status(500).json({ error: 'Platform mode: No user found in database' });
            }
            req.user = user;
            return next();
        } catch (error) {
            console.error('Platform mode error:', error);
            return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
        }
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        res.setHeader('X-Auth-Error', 'invalid-token');
        return res.status(401).json({
            error: 'Access denied. No token provided.',
            code: 'AUTH_TOKEN_INVALID',
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        const user = userDb.getUserById(decoded.userId);
        if (!user) {
            res.setHeader('X-Auth-Error', 'invalid-token');
            return res.status(401).json({
                error: 'Invalid token. User not found.',
                code: 'AUTH_TOKEN_INVALID',
            });
        }
        if (!isWithinRefreshGrace(decoded)) {
            res.setHeader('X-Auth-Error', 'session-expired');
            return res.status(401).json({
                error: 'Session expired beyond refresh grace. Please log in again.',
                code: 'AUTH_TOKEN_EXPIRED',
            });
        }
        req.user = user;
        next();
    } catch (error) {
        console.warn(
            'Refresh token verification failed:',
            error instanceof Error ? error.message : String(error),
        );
        res.setHeader('X-Auth-Error', 'invalid-token');
        return res.status(401).json({
            error: 'Invalid token',
            code: 'AUTH_TOKEN_INVALID',
        });
    }
};

export {
  validateApiKey,
  authenticateToken,
  authenticateRefresh,
  isWithinRefreshGrace,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
