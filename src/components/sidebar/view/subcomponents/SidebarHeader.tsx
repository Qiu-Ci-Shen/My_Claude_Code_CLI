import { Activity, Archive, Folder, FolderPlus, Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input, Tooltip } from '../../../../shared/view/ui';
import { WORDMARK_FONT_FAMILY } from '../../../../shared/constants';
import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const showSearchTools = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'archived'
    ? t('search.archivedPlaceholder', 'Search archived sessions...')
    : searchMode === 'running'
      ? t('search.runningPlaceholder', 'Search running sessions...')
      : t('projects.searchPlaceholder');
  const runningBadgeText = runningSessionsCount > 99 ? '99+' : String(runningSessionsCount);

  const LogoBlock = () => (
    <div className="flex min-w-0 items-center gap-2.5">
      <h1
        className="truncate text-sm font-bold tracking-tight text-foreground"
        style={{ fontFamily: WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          <LogoBlock />

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isRefreshing ? 'animate-spin' : ''
                }`}
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search bar */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle: 项目 / 运行中 / 归档（计数徽章内嵌，互不遮挡） */}
            <div className="grid grid-cols-3 rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="top" containerClassName="min-w-0">
                <button
                  onClick={() => onSearchModeChange('running')}
                  aria-pressed={searchMode === 'running'}
                  aria-label={t('search.runningTooltip', 'Running sessions')}
                  className={cn(
                    "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'running'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Activity className={cn("h-3 w-3", runningSessionsCount > 0 && "text-emerald-500")} />
                  {t('search.modeRunning', 'Running')}
                  {runningSessionsCount > 0 && (
                    <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white">
                      {runningBadgeText}
                    </span>
                  )}
                </button>
              </Tooltip>
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top" containerClassName="min-w-0">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                  {t('archived.title', 'Archive')}
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          <LogoBlock />

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {showSearchTools && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle: 项目 / 运行中 / 归档（计数徽章内嵌，互不遮挡） */}
            <div className="grid grid-cols-3 rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <Tooltip content={t('search.runningTooltip', 'Running sessions')} position="top" containerClassName="min-w-0">
                <button
                  onClick={() => onSearchModeChange('running')}
                  aria-pressed={searchMode === 'running'}
                  aria-label={t('search.runningTooltip', 'Running sessions')}
                  className={cn(
                    "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'running'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Activity className={cn("h-3 w-3", runningSessionsCount > 0 && "text-emerald-500")} />
                  {t('search.modeRunning', 'Running')}
                  {runningSessionsCount > 0 && (
                    <span className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold leading-none text-white">
                      {runningBadgeText}
                    </span>
                  )}
                </button>
              </Tooltip>
              <Tooltip content={t('search.archiveOnlyTooltip', 'Archive only')} position="top" containerClassName="min-w-0">
                <button
                  onClick={() => onSearchModeChange('archived')}
                  aria-pressed={searchMode === 'archived'}
                  aria-label={t('search.archiveOnlyTooltip', 'Archive only')}
                  className={cn(
                    "flex w-full min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-xs font-normal transition-all",
                    searchMode === 'archived'
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Archive className="h-3 w-3" />
                  {t('archived.title', 'Archive')}
                </button>
              </Tooltip>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder={searchPlaceholder}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
