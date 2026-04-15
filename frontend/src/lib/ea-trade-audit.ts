import { createAdminClient } from "@/utils/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

type CommandRow = {
  command_type: string;
  payload_json?: Record<string, unknown> | null;
  sequence_no?: number | null;
};

type RuntimeEventRow = {
  id?: number;
  event_type: string;
  payload?: Record<string, unknown> | null;
  created_at?: string;
};

function asText(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function invertSide(side: string) {
  if (side === "buy") return "sell";
  if (side === "sell") return "buy";
  return side;
}

function mapAckStatusToAuditStatus(status: string) {
  return status === "acknowledged" ? "accepted" : "rejected";
}

async function auditExistsForCommand(
  admin: AdminClient,
  connectionId: string,
  decisionReason: string,
  commandId: string,
  brokerTicket: string | null,
) {
  if (brokerTicket) {
    const { data, error } = await admin
      .from("ea_trade_audit")
      .select("id")
      .eq("connection_id", connectionId)
      .eq("decision_reason", decisionReason)
      .eq("broker_ticket", brokerTicket)
      .limit(1);

    if (error) {
      throw new Error(`Failed to check trade audit dedupe by broker ticket: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }

  const { data, error } = await admin
    .from("ea_trade_audit")
    .select("id")
    .eq("connection_id", connectionId)
    .contains("payload", { source_command_id: commandId })
    .limit(1);

  if (error) {
    throw new Error(`Failed to check trade audit dedupe by command id: ${error.message}`);
  }

  return (data ?? []).length > 0;
}

async function auditExistsForRuntimeEvent(
  admin: AdminClient,
  connectionId: string,
  decisionReason: string,
  sourceEventType: string,
  sourceEventId: number | null,
  brokerTicket: string | null,
) {
  if (brokerTicket) {
    const { data, error } = await admin
      .from("ea_trade_audit")
      .select("id")
      .eq("connection_id", connectionId)
      .eq("decision_reason", decisionReason)
      .eq("broker_ticket", brokerTicket)
      .limit(1);

    if (error) {
      throw new Error(`Failed to check runtime-event audit dedupe by broker ticket: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }

  if (sourceEventId != null) {
    const { data, error } = await admin
      .from("ea_trade_audit")
      .select("id")
      .eq("connection_id", connectionId)
      .contains("payload", { source_event_id: sourceEventId, source_event_type: sourceEventType })
      .limit(1);

    if (error) {
      throw new Error(`Failed to check runtime-event audit dedupe by event id: ${error.message}`);
    }

    return (data ?? []).length > 0;
  }

  return false;
}

export async function persistTradeAuditFromCommandAck(
  admin: AdminClient,
  input: {
    connectionId: string;
    commandId: string;
    ackStatus: string;
    ackPayload?: Record<string, unknown> | null;
    createdAt: string;
  },
) {
  const { data: commandRows, error: commandError } = await admin
    .from("ea_commands")
    .select("command_type, payload_json, sequence_no")
    .eq("id", input.commandId)
    .eq("connection_id", input.connectionId)
    .limit(1);

  if (commandError) {
    throw new Error(`Failed to load EA command for audit persistence: ${commandError.message}`);
  }

  const command = ((commandRows ?? [])[0] ?? null) as CommandRow | null;
  if (!command) return false;

  if (command.command_type !== "manual_trade" && command.command_type !== "close_position") {
    return false;
  }

  const commandPayload = (command.payload_json ?? {}) as Record<string, unknown>;
  const ackPayload = (input.ackPayload ?? {}) as Record<string, unknown>;
  const symbol = asText(ackPayload.symbol) || asText(commandPayload.symbol);
  const rawSide = asText(commandPayload.side).toLowerCase();
  const side = command.command_type === "close_position" ? invertSide(rawSide) : rawSide;
  if (!symbol || !side) return false;

  const brokerTicket = asText(ackPayload.order_id) || null;
  if (await auditExistsForCommand(admin, input.connectionId, command.command_type, input.commandId, brokerTicket)) {
    return false;
  }

  const payload = {
    source: "ea_command_ack",
    source_command_id: input.commandId,
    source_sequence_no: Number(command.sequence_no ?? 0) || null,
    source_command_type: command.command_type,
    command_payload: commandPayload,
    ack_payload: ackPayload,
  };

  const { error } = await admin
    .from("ea_trade_audit")
    .insert({
      connection_id: input.connectionId,
      symbol,
      side,
      entry: asNullableNumber(commandPayload.entry) ?? asNullableNumber(commandPayload.entry_price),
      sl: asNullableNumber(commandPayload.sl),
      tp: asNullableNumber(commandPayload.tp),
      volume: asNullableNumber(commandPayload.volume),
      decision_reason: command.command_type,
      broker_ticket: brokerTicket,
      status: mapAckStatusToAuditStatus(input.ackStatus),
      payload,
      created_at: input.createdAt,
    });

  if (error) {
    throw new Error(`Failed to insert trade audit from command ack: ${error.message}`);
  }

  return true;
}

export async function persistTradeAuditFromRuntimeEvent(
  admin: AdminClient,
  input: {
    connectionId: string;
    event: RuntimeEventRow;
  },
) {
  const eventPayload = (input.event.payload ?? {}) as Record<string, unknown>;
  const nestedPayload = eventPayload.payload && typeof eventPayload.payload === "object"
    ? (eventPayload.payload as Record<string, unknown>)
    : {};

  let decisionReason = "";
  if (input.event.event_type === "armed_trade_executed" || input.event.event_type === "armed_trade_rejected") {
    decisionReason = "armed_trade";
  }

  if (!decisionReason) {
    return false;
  }

  const symbol = asText(eventPayload.symbol);
  const side = asText(eventPayload.side).toLowerCase();
  if (!symbol || !side) return false;

  const brokerTicket = asText(nestedPayload.order_id) || null;
  const sourceEventId = typeof input.event.id === "number" ? input.event.id : null;
  if (await auditExistsForRuntimeEvent(admin, input.connectionId, decisionReason, input.event.event_type, sourceEventId, brokerTicket)) {
    return false;
  }

  const payload = {
    source: "ea_runtime_event",
    source_event_id: sourceEventId,
    source_event_type: input.event.event_type,
    source_setup_id: asText(eventPayload.setup_id) || null,
    runtime_payload: eventPayload,
    execution_payload: nestedPayload,
  };

  const { error } = await admin
    .from("ea_trade_audit")
    .insert({
      connection_id: input.connectionId,
      symbol,
      side,
      entry: null,
      sl: null,
      tp: null,
      volume: asNullableNumber(nestedPayload.volume),
      decision_reason: decisionReason,
      broker_ticket: brokerTicket,
      status: input.event.event_type === "armed_trade_executed" ? "accepted" : "rejected",
      payload,
      created_at: input.event.created_at ?? new Date().toISOString(),
    });

  if (error) {
    throw new Error(`Failed to insert trade audit from runtime event: ${error.message}`);
  }

  return true;
}