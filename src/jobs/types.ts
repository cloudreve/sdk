/** @public */
export enum TaskStatus {
  queued = "queued",
  processing = "processing",
  suspending = "suspending",
  error = "error",
  canceled = "canceled",
  completed = "completed",
}

/** @public */
export enum TaskType {
  remote_download = "remote_download",
  create_archive = "create_archive",
  extract_archive = "extract_archive",
  relocate = "relocate",
  media_meta = "media_meta",
  entity_recycle_routine = "entity_recycle_routine",
  explicit_entity_recycle = "explicit_entity_recycle",
  upload_sentinel_check = "upload_sentinel_check",
  import = "import",
}

/** @public */
export enum DownloadTaskState {
  seeding = "seeding",
  downloading = "downloading",
  error = "error",
  completed = "completed",
  unknown = "unknown",
}

/** @public */
export enum ListTaskCategory {
  general = "general",
  downloading = "downloading",
  downloaded = "downloaded",
}

/** @public */
export interface TaskListResponse {
  tasks: TaskResponse[];
  pagination: PaginationResults;
}

/** @public */
export interface PaginationResults {
  page: number;
  page_size: number;
  total_items?: number;
  next_token?: string;
}

/** @public */
export interface TaskResponse {
  id: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  type: TaskType;
  node?: NodeSummary;
  summary?: TaskSummary;
  error?: string;
  error_history?: string[];
  duration?: number;
  resume_time?: number;
  retry_count?: number;
}

/** @public */
export interface NodeSummary {
  id: string;
  name: string;
}

/** @public */
export interface TaskSummary {
  phase?: string;
  props: TaskSummaryProps;
}

/** @public */
export interface TaskSummaryProps {
  src?: string;
  src_str?: string;
  dst?: string;
  src_multiple?: string[];
  dst_policy_id?: string;
  failed?: number;
  download?: DownloadTaskStatus;
}

/** @public */
export interface DownloadTaskStatus {
  name: string;
  state: DownloadTaskState;
  total: number;
  downloaded: number;
  download_speed: number;
  upload_speed: number;
  uploaded: number;
  files?: DownloadTaskFile[];
  hash?: string;
  pieces?: string;
  num_pieces?: number;
}

/** @public */
export interface DownloadTaskFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  selected: boolean;
}
