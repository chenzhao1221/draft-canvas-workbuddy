// Public API of @draft-canvas/host-workbuddy: the browser adapter and its transport.
// The hub (server/) is a Node program and is not exported here; run it with `draft-canvas-wb`.
export { WorkBuddyAdapter } from './adapter';
export type { Transport, WorkBuddyAdapterOptions } from './adapter';
export { HttpTransport } from './transport';
export { LocalStorageWorkingCopies } from './storage';
export type { KeyValueStorage } from './storage';
export type { HistoryBody, HubInfo, InjectBody, SessionSummary, StreamFrame } from './protocol';
export { ADAPTER_VERSION, HOST_DISPLAY_NAME, HOST_ID, HUB_PROTOCOL_VERSION } from './protocol';
