// Shape of a row in public.relay_messages (migration 100).
export interface RelayMessage {
  id: string;
  workspace_id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  body: string;
  template_name: string | null;
  template_language: string | null;
  template_values: Record<string, unknown> | null;
  provider_msg_id: string | null;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  error_code: string | null;
  error_detail: string | null;
  media_url: string | null;
  media_type: 'image' | 'document' | 'audio' | 'video' | 'sticker' | null;
  media_name: string | null;
  media_mime: string | null;
  media_path: string | null;
  media_size: number | null;
  is_internal: boolean;
  sent_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Shape of a row in public.relay_conversations. */
export interface RelayConversation {
  id: string;
  workspace_id: string;
  lead_id: string | null;
  phone_e164: string;
  status: 'open' | 'closed';
  unread_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  last_preview: string | null;
  last_direction: 'in' | 'out' | null;
  last_status: RelayMessage['status'] | null;
  spotlight: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** An approved WhatsApp template registered in Migrizo (migration 105). */
export interface RelayTemplate {
  id: string;
  workspace_id: string;
  name: string;
  language: string;
  body: string;
  category: string | null;
  variable_count: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A saved quick reply, optionally with files that go out with it. */
export interface QuickReply {
  id: string;
  workspace_id: string;
  shortcut: string;
  title: string;
  body: string;
  attachments: { path: string; name: string; mime: string; size: number }[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}
