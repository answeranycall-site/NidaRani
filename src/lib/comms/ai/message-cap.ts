import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import type { ConfiguredChannelId } from "@/lib/comms/ai/agent";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/**
 * Shared by every inbound-AI orchestrator (SMS/WhatsApp in
 * lib/comms/ai/respond.ts, Web Chat in lib/comms/web-chat/respond.ts) that
 * supports `AiChannelConfig.outboundMessageLimitPerContact` — the per-contact
 * cap that stops the agent burning model + send spend on a troll or a scam
 * loop. Centralised so every channel counts and alerts identically instead
 * of drifting.
 */

/**
 * How many AI-generated replies this contact has already received on this
 * channel. Uses a Firestore count aggregation rather than fetching the docs —
 * this runs on every inbound message once a cap is configured, and a chatty
 * thread would otherwise mean downloading the whole history each time.
 *
 * Returns null on failure, which callers treat as "don't enforce" — a
 * transient Firestore blip should not silence a working agent.
 */
export async function countAiRepliesSent(
  contactId: string,
  messagesCollection: string,
): Promise<number | null> {
  try {
    const snap = await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection(messagesCollection)
      .where("aiGenerated", "==", true)
      .count()
      .get();
    return snap.data().count;
  } catch (err) {
    console.warn("[ai/message-cap] AI reply count failed — cap not enforced", err);
    return null;
  }
}

/**
 * One-time "the bot stopped replying to this person" heads-up, so a capped
 * contact who turns out to be a real lead doesn't just vanish. Deduped per
 * contact PER CHANNEL via `contacts/{id}.aiCapAlertedChannels`, so hitting
 * the SMS cap and later the WhatsApp cap each notify exactly once.
 */
export async function notifyOwnerOfCapReached(input: {
  subAccountId: string;
  subAccount: SubAccountDoc;
  contact: Contact;
  /** Fallback identity when the contact has no name/phone on file yet
   *  (e.g. a web-chat visitor's session id). */
  fallbackIdentity: string;
  channelId: ConfiguredChannelId;
  channelLabel: string;
  cap: number;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.collection("contacts").doc(input.contact.id);

  // Transactional claim so two inbound messages landing together can't both
  // notify — same pattern as the new-lead alert in lib/leads/new-lead-alert.ts.
  let claimed = false;
  try {
    claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const already = (snap.get("aiCapAlertedChannels") as string[] | null) ?? [];
      if (already.includes(input.channelId)) return false;
      tx.set(
        ref,
        {
          aiCapAlertedAt: FieldValue.serverTimestamp(),
          aiCapAlertedChannels: FieldValue.arrayUnion(input.channelId),
        },
        { merge: true },
      );
      return true;
    });
  } catch (err) {
    console.warn("[ai/message-cap] cap-alert claim failed", err);
    return;
  }
  if (!claimed) return;

  const who =
    (input.contact.name ?? "").trim() ||
    input.contact.phone ||
    input.fallbackIdentity;
  const ownerEmail = input.subAccount.accountContact?.email?.trim();
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
  const link = `${appUrl}/sa/${input.subAccountId}/conversations/${input.contact.id}`;

  if (ownerEmail && emailIsConfigured()) {
    try {
      await sendEmail({
        to: ownerEmail,
        subject: `AI stopped replying to ${who}`,
        text: [
          `${who} has hit the ${input.cap}-message limit you set for the AI agent on ${input.channelLabel}.`,
          "",
          "The AI will not reply to them again on this channel. If they're a",
          "real lead rather than a time-waster, pick the conversation up",
          "yourself — or raise the limit in AI Agents → " +
            `${input.channelLabel} → settings.`,
          "",
          link,
        ].join("\n"),
        from: tenantFrom(input.subAccount),
      });
    } catch (err) {
      console.warn("[ai/message-cap] cap-alert email failed", err);
    }
  }
}
