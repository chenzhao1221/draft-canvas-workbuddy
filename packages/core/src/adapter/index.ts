export { INTERFACE_VERSION } from './host';
export type {
  HistoryCompleteness,
  HostAdapter,
  HostCapabilities,
  HostEvent,
  HostInfo,
  InjectResult,
  Message,
  MessageRole,
  SendResult,
  SessionRef,
  TranscriptFidelity,
  WorkingCopyStorage,
} from './host';
export { HostAdapterError } from './errors';
export type { HostAdapterErrorCode } from './errors';
export type {
  ChangelogFence,
  DraftFence,
  DraftVersion,
  FenceKind,
  RewriteRequest,
  SearchReplaceBlock,
  WorkingCopy,
} from './data';
