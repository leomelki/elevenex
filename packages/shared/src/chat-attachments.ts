/** One bounded chunk of a user-selected file. No local paths cross this boundary. */
export interface ChatAttachmentUpload {
  readonly taskId: number;
  readonly sessionId: number;
  readonly requestId: string;
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly data: string;
}
export interface ChatAttachmentReceipt {
  readonly id: string;
  readonly offset: number;
  /** Present only once the complete file is durable on the selected machine. */
  readonly path: string | null;
}
