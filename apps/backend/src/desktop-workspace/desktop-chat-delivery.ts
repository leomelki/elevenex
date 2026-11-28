import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isSessionChatDeliveryId } from '@elevenex/shared';
import type { AgentPromptDisposition } from '../agent-runtime/agent-runtime.types.js';
import type { SessionPromptReceipts } from '../sessions/session-prompt-receipts.js';

const logger = new Logger('DesktopChatDelivery');

function hash(value: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function desktopChatDeliveryKey(sessionId: number, deliveryId: unknown): string {
  if (!isSessionChatDeliveryId(deliveryId)) throw new BadRequestException('Invalid conversation delivery ID.');
  // Keep desktop sends separate from inter-session and MCP requests.
  return hash(['desktop-chat', sessionId, deliveryId]);
}

export async function trackDesktopChatDelivery(
  receipts: SessionPromptReceipts | undefined,
  sessionId: number,
  deliveryId: unknown,
  inputs: readonly unknown[],
  send: (dispatch?: () => void, onAccepted?: (disposition: AgentPromptDisposition) => void) => Promise<void>,
  settled?: (deliveryId: string) => void,
): Promise<void> {
  if (deliveryId === undefined) return send();

  if (!isSessionChatDeliveryId(deliveryId)) throw new BadRequestException('Invalid conversation delivery ID.');
  const key = desktopChatDeliveryKey(sessionId, deliveryId);
  if (!receipts) throw new ServiceUnavailableException('Message receipts are unavailable.');
  const { created, receipt } = receipts.reserve({
    id: randomUUID(), key, fingerprint: hash(inputs), sessionId, senderId: null, delivery: 'preparing',
  });
  if (!created) {
    if (receipt.delivery === 'accepted') return;
    if (receipt.delivery === 'failed') throw new ConflictException('The message was rejected.');
    throw new ServiceUnavailableException('Message delivery is still unconfirmed.');
  }

  const record = (state: 'accepted' | 'failed', disposition?: AgentPromptDisposition) => {
    if (receipts.record(receipt.id, state, disposition)) settled?.(deliveryId);
  };
  const unconfirmed = () => {
    if (receipts.markUnconfirmed(receipt.id)) settled?.(deliveryId);
    return new ServiceUnavailableException('Message delivery is still unconfirmed.');
  };
  let dispatched = false;
  let accepted = false;
  try {
    await send(() => {
      receipts.beginDispatch(receipt.id);
      dispatched = true;
    }, disposition => {
      if (!dispatched || accepted) return;
      accepted = true;
      try {
        record('accepted', disposition);
      } catch {
        // Keep a receipt-write failure out of the harness callback. Try again
        // after submitPrompt returns, without dispatching a second message.
        logger.error(`Could not save prompt acceptance for session ${sessionId}.`);
      }
    });
  } catch (error) {
    if (!accepted) {
      if (!dispatched) {
        record('failed');
        throw error;
      }
      // An error after the boundary (including a provider-side 4xx) is not
      // itself proof that the native request could not have taken effect.
      throw unconfirmed();
    }
  }
  if (!accepted) {
    if (dispatched) throw unconfirmed();
    record('failed');
    throw new ConflictException('The agent stopped before the message was sent.');
  }
  record('accepted');
}
