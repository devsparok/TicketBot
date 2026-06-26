const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { QuickDB } = require("quick.db");

const STORAGE_DIRECTORY = path.join(process.cwd(), "storage");
const DATABASE_PATH = path.join(STORAGE_DIRECTORY, "ticketbot.sqlite");

fs.mkdirSync(STORAGE_DIRECTORY, { recursive: true });

const rootDatabase = new QuickDB({ filePath: DATABASE_PATH });
const guildSettingsTable = rootDatabase.table("guildSettings");
const ticketsTable = rootDatabase.table("tickets");
const countersTable = rootDatabase.table("counters");

let connectionReady = false;

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function toTimestamp(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? fallback : timestamp;
}

function normalizeGuildSettings(guildId, settings = {}, existingSettings = null) {
  const now = Date.now();
  const safeSettings = { ...settings };

  delete safeSettings._id;
  delete safeSettings.createdAt;
  delete safeSettings.updatedAt;
  delete safeSettings.guildId;

  return {
    ...cloneValue(existingSettings ?? {}),
    ...cloneValue(safeSettings),
    guildId,
    createdAt: existingSettings?.createdAt ?? now,
    updatedAt: now,
  };
}

function normalizeTicket(ticketData) {
  return {
    _id: ticketData._id ?? randomUUID(),
    guildId: ticketData.guildId,
    channelId: ticketData.channelId ?? null,
    categoryId: ticketData.categoryId ?? null,
    ownerId: ticketData.ownerId,
    subject: ticketData.subject,
    description: ticketData.description,
    sequence: Number(ticketData.sequence),
    displayId: ticketData.displayId,
    openedAt: toTimestamp(ticketData.openedAt, Date.now()),
    closedAt: toTimestamp(ticketData.closedAt, null),
    closedById: ticketData.closedById ?? null,
    status: ticketData.status ?? "open",
    staffRoleId: ticketData.staffRoleId ?? null,
    logChannelId: ticketData.logChannelId ?? null,
    rating: ticketData.rating ?? null,
    ratingFeedback: ticketData.ratingFeedback ?? null,
    ratedAt: toTimestamp(ticketData.ratedAt, null),
    closeReason: ticketData.closeReason ?? null,
  };
}

function createDuplicateKeyError(message, keyPattern) {
  return {
    name: "QuickDbDuplicateKeyError",
    code: "SQLITE_CONSTRAINT_UNIQUE",
    keyPattern,
    message,
  };
}

async function listTicketValues() {
  const rows = await ticketsTable.all();
  return rows.map(({ value }) => value);
}

async function connectDatabase() {
  if (connectionReady) {
    return rootDatabase;
  }

  await rootDatabase.init();
  connectionReady = true;
  console.log(`[Database] Connected: quick.db (${DATABASE_PATH})`);
  return rootDatabase;
}

async function getGuildSettings(guildId) {
  const settings = await guildSettingsTable.get(guildId);
  return cloneValue(settings ?? null);
}

async function saveGuildSettings(guildId, settings) {
  const currentSettings = await guildSettingsTable.get(guildId);
  const nextSettings = normalizeGuildSettings(guildId, settings, currentSettings);

  await guildSettingsTable.set(guildId, nextSettings);
  return cloneValue(nextSettings);
}

async function getOpenTicketByUser(guildId, ownerId) {
  const tickets = await listTicketValues();
  const ticket = tickets.find((entry) => entry.guildId === guildId && entry.ownerId === ownerId && entry.status === "open");
  return cloneValue(ticket ?? null);
}

async function getOpenTicketByChannel(channelId) {
  const tickets = await listTicketValues();
  const ticket = tickets.find((entry) => entry.channelId === channelId && entry.status === "open");
  return cloneValue(ticket ?? null);
}

async function getClosedTicketById(ticketDocumentId) {
  const ticket = await ticketsTable.get(ticketDocumentId);

  if (!ticket || ticket.status !== "closed") {
    return null;
  }

  return cloneValue(ticket);
}

async function getNextTicketSequence(guildId) {
  const currentValue = (await countersTable.get(guildId)) ?? 0;
  const nextValue = Number(currentValue) + 1;

  await countersTable.set(guildId, nextValue);
  return nextValue;
}

async function createTicket(ticketData) {
  const ticket = normalizeTicket(ticketData);
  const tickets = await listTicketValues();

  if (tickets.some((entry) => entry.guildId === ticket.guildId && entry.ownerId === ticket.ownerId && entry.status === "open")) {
    throw createDuplicateKeyError("An open ticket already exists for this user in this guild.", {
      guildId: 1,
      ownerId: 1,
      status: 1,
    });
  }

  if (tickets.some((entry) => entry.guildId === ticket.guildId && entry.sequence === ticket.sequence)) {
    throw createDuplicateKeyError("This ticket sequence already exists for the guild.", {
      guildId: 1,
      sequence: 1,
    });
  }

  if (ticket.channelId && tickets.some((entry) => entry.channelId === ticket.channelId)) {
    throw createDuplicateKeyError("This channel is already linked to another ticket.", {
      channelId: 1,
    });
  }

  await ticketsTable.set(ticket._id, ticket);
  return cloneValue(ticket);
}

async function closeTicketByChannel(channelId, closedById, logChannelId) {
  const ticket = await getOpenTicketByChannel(channelId);

  if (!ticket) {
    return null;
  }

  const nextTicket = {
    ...ticket,
    status: "closed",
    closedAt: Date.now(),
    closedById,
    logChannelId: logChannelId ?? null,
    closeReason: "closed",
  };

  await ticketsTable.set(nextTicket._id, nextTicket);
  return cloneValue(nextTicket);
}

async function markTicketAsDeleted(ticketDocumentId) {
  const ticket = await ticketsTable.get(ticketDocumentId);

  if (!ticket || ticket.status !== "open") {
    return null;
  }

  const nextTicket = {
    ...ticket,
    status: "deleted",
    closedAt: Date.now(),
    closeReason: "channel_missing",
  };

  await ticketsTable.set(nextTicket._id, nextTicket);
  return cloneValue(nextTicket);
}

async function saveTicketRating(ticketDocumentId, ownerId, rating, ratingFeedback = null) {
  const ticket = await ticketsTable.get(ticketDocumentId);

  if (!ticket || ticket.ownerId !== ownerId || ticket.status !== "closed") {
    return null;
  }

  const nextTicket = {
    ...ticket,
    rating,
    ratingFeedback,
    ratedAt: Date.now(),
  };

  await ticketsTable.set(nextTicket._id, nextTicket);
  return cloneValue(nextTicket);
}

async function listTicketsByGuild(guildId) {
  const tickets = await listTicketValues();
  return tickets
    .filter((ticket) => ticket.guildId === guildId)
    .map((ticket) => cloneValue(ticket));
}

async function resetGuildData(guildId) {
  const tickets = await listTicketValues();
  const guildTickets = tickets.filter((ticket) => ticket.guildId === guildId);

  await Promise.all([
    ...guildTickets.map((ticket) => ticketsTable.delete(ticket._id)),
    guildSettingsTable.delete(guildId),
    countersTable.delete(guildId),
  ]);

  return {
    deletedTicketDocuments: guildTickets.length,
  };
}

async function countOpenTicketsByGuild(guildId) {
  const tickets = await listTicketValues();
  return tickets.filter((ticket) => ticket.guildId === guildId && ticket.status === "open").length;
}

async function countSolvedTickets() {
  const tickets = await listTicketValues();
  return tickets.filter((ticket) => ticket.status === "closed").length;
}

async function countSolvedTicketsByGuild(guildId) {
  const tickets = await listTicketValues();
  return tickets.filter((ticket) => ticket.guildId === guildId && ticket.status === "closed").length;
}

function isDuplicateKeyError(error) {
  return error?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

module.exports = {
  closeTicketByChannel,
  connectDatabase,
  countOpenTicketsByGuild,
  countSolvedTickets,
  countSolvedTicketsByGuild,
  createTicket,
  getClosedTicketById,
  getGuildSettings,
  getNextTicketSequence,
  getOpenTicketByChannel,
  getOpenTicketByUser,
  isDuplicateKeyError,
  listTicketsByGuild,
  markTicketAsDeleted,
  resetGuildData,
  saveGuildSettings,
  saveTicketRating,
};
