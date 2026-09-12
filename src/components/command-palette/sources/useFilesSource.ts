import { api } from '../../../utils/api';

import { useApiSource } from './useApiSource';

export type FileResult = {
  path: string;
  name: string;
};

interface FileNode {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
}

// 面板「Browse all files」渲染上限。500 会按 DFS 序截断（构建产物目录排在
// 源码前面时把源码挤出列表，实测 D:\Claude_Tools 工作区 1438 个文件里
// package.json 排在第 1422 位），提高上限让全量进入；仍设上限防止超大
// 工作区（万级文件）把面板渲染拖垮。
const MAX_FILES = 1500;

function flatten(nodes: FileNode[], out: FileResult[]): void {
  for (const node of nodes) {
    if (out.length >= MAX_FILES) return;
    if (node.type === 'file') {
      out.push({ path: node.path, name: node.name });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
}

export function useFilesSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<FileResult, unknown>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => api.getFiles(projectId!, { signal }),
    parse: (data) => {
      const tree: FileNode[] = Array.isArray(data) ? (data as FileNode[]) : [];
      const flat: FileResult[] = [];
      flatten(tree, flat);
      return flat;
    },
  });
}
