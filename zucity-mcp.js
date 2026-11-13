#!/usr/bin/env node
/**
 * zucity-mcp — Model Context Protocol server for ZuCity Japan bookings.
 *
 * Tools: search_inventory, get_calendar, check_availability, quote_price,
 *        build_purchase_calldata, get_receipt_status, list_application_forms,
 *        booking_link, get_reviews, resolve_referral_code, get_facts.
 *
 * Security model: read + encode + link ONLY. This server never holds keys,
 * never signs, never sends transactions. build_purchase_calldata returns
 * ready-to-sign transaction objects for the USER'S wallet to sign.
 *
 * Config (env):
 *   ZUCITY_BASE_URL  default https://zucity.org
 *   ZUCITY_CHAIN_ID  default 1 (Ethereum mainnet — REAL FUNDS). 11155111 = Sepolia sandbox.
 *   ZUCITY_RPC_URL   default: public RPC for the selected chain
 *   ZUCITY_REFERRER  optional 0x address used as default onchain referrer
 *
 * Docs: https://github.com/kibagateaux/zucity-api-docs (api.md, contracts.md, skills.md, facts.json)
 * Generated from zucity-webapp private repo state @ f0d0bfb, 2026-11-13.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient, http, encodeFunctionData, decodeFunctionData,
  getAddress, isAddress, zeroAddress, formatUnits,
} from "viem";
import { mainnet, sepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Ground truth (mirrors facts.json; regenerate per release)
// ---------------------------------------------------------------------------
const GENERATED_FROM = "zucity-webapp@f0d0bfb (2026-11-13); contract addresses from the JapanGlobalSystem deploy, live-verified 2026-08-16";

const FACTS = {
  baseUrlDefault: "https://zucity.org",
  chains: {
    1: {
      role: "production — REAL FUNDS",
      zuCitySystem: "0xe94320a13359dd9ec7b99d1a210d146583c5c90e",
      systemName: "JapanGlobalSystem",
      receiptValidatorDefault: "0x6bcf7944fcb333cf4c414f2b8fa97786297f4177",
      receiptRenderer: "0x3f83af192b947e0f13e6727554b702d08673d54d",
      paymentToken: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      nft: { name: "Japan Global", symbol: "JPG" },
      cancelFeeBps: 3000,
      referrerFeeBps: 1000,
      rpcDefault: "https://ethereum-rpc.publicnode.com",
      referrerFeeNote: "buy/bulkBuy pay the referrer address a cash split recorded in the receipt; mainnet referrerFeeBps() = 1000 (10%, verified 2026-08-16, manager-mutable) — read the getter, or receipts(id).referrerFee for a specific receipt",
    },
    11155111: {
      role: "sandbox (Sepolia)",
      zuCitySystem: "0x62c1c7735fc2f166e6124b945b10ee1daaef2ea6",
      systemName: "ZuCitySystem (pre-rename sandbox deploy; ABI identical to JapanGlobalSystem)",
      receiptValidatorDefault: "0x82a54c16436f9b402bf7d8eaf743cfd44e1a4f12",
      receiptRenderer: "0xcb4275a65f3e736c0e5710537062500673772e48",
      paymentToken: { symbol: "ZUJPTT", address: "0xd920443209bA7d9B6d178021016AAfDCA88f8DfC", decimals: 8 },
      nft: { name: "ZuCity Japan Network", symbol: "ZUJP" },
      cancelFeeBps: 3000,
      referrerFeeBps: 1000,
      referrerFeeNote: "Sepolia getter is referrerFeeBPS() (capital) = 1000 (10%); casing differs from mainnet's referrerFeeBps()",
      rpcDefault: "https://ethereum-sepolia-rpc.publicnode.com",
    },
  },
  enums: {
    itemType: { 0: "Ticket", 1: "Membership", 2: "Sponsorship", 3: "Art", 4: "Merch", 5: "Service", 6: "Room", 7: "Suite", 8: "Villa", 9: "Venue", 10: "Equipment" },
    receiptStatus: { 0: "Pending", 1: "Accepted", 2: "Canceled", 3: "Redeemed" },
  },
  dateEncoding: {
    epochYear: 2023, daysPerYear: 364,
    rule: "year = calendarYear - 2023; startDay = 1-indexed day of year; daysCount = inclusive calendar days",
  },
  sentinelPrice: 340282366920938463463374607431768211454n, // 2^128 - 2 → application-gated item
  rateLimitsPerIpPerMinute: { trpc: 20, checkoutCallsEach: 60, restGuidance: 30 },
  cardPricing: "card = crypto × 1.25 (crypto is 20% off card); the server prices every line — checkout.quote, then checkout.prepare (api.md § Card payments)",
  referral: { codeRegex: "^[a-zA-Z0-9_-]{3,30}$", link: "https://zucity.org/?ref=<code>", checkoutField: "referral_code on checkout.prepare" },
  notSupported: [
    "GET /api/inventory/{id} (404) — fetch the list, select by id",
    "free-text search — use documented filters",
    "API keys / programmatic signup — authenticated calls need a Privy session JWT from zucity.org",
    "itemsCounter() — enumerate via allItems or /api/calendars?format=json",
    "buying sentinel-priced (application-gated) items — use the apply flow",
    "JPY-priced items onchain — fiat path only",
  ],
};

// Consumer subset of the booking-system ABI (JapanGlobalSystem / ZuCitySystem — identical), verbatim from the source ABI file.
const ZUCITY_ABI = [{"type":"function","name":"allItems","inputs":[{"name":"idStartIndex","type":"uint64","internalType":"uint64"},{"name":"manager","type":"address","internalType":"address"},{"name":"itemType","type":"uint8","internalType":"uint8"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"segmentCount","type":"uint16","internalType":"uint16"}],"outputs":[{"name":"","type":"tuple[]","internalType":"struct ItemDisplayData[]","components":[{"name":"id","type":"uint64","internalType":"uint64"},{"name":"minUnitPrice","type":"uint128","internalType":"uint128"},{"name":"itemType","type":"uint8","internalType":"enum ItemType"},{"name":"transferable","type":"bool","internalType":"bool"},{"name":"unlimited","type":"bool","internalType":"bool"},{"name":"token","type":"address","internalType":"address"},{"name":"manager","type":"address","internalType":"address"},{"name":"receiptValidator","type":"address","internalType":"address"},{"name":"reservations","type":"uint256[]","internalType":"uint256[]"},{"name":"segments","type":"bytes32[]","internalType":"bytes32[]"}]}],"stateMutability":"view"},{"type":"function","name":"allReceipts","inputs":[{"name":"idStartIndex","type":"uint256","internalType":"uint256"},{"name":"itemFilter","type":"uint64[]","internalType":"uint64[]"},{"name":"recipient","type":"address","internalType":"address"},{"name":"status","type":"uint8","internalType":"uint8"}],"outputs":[{"name":"","type":"tuple[]","internalType":"struct Receipt[]","components":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ReceiptStatus"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"},{"name":"totalPaid","type":"uint128","internalType":"uint128"},{"name":"recipient","type":"address","internalType":"address"},{"name":"referrerFee","type":"uint128","internalType":"uint128"},{"name":"token","type":"address","internalType":"address"}]}],"stateMutability":"view"},{"type":"function","name":"availabilityCalendar","inputs":[{"name":"","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"balanceOf","inputs":[{"name":"owner","type":"address","internalType":"address"}],"outputs":[{"name":"result","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"bulkBuy","inputs":[{"name":"reservations","type":"tuple[]","internalType":"struct Receipt[]","components":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ReceiptStatus"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"},{"name":"totalPaid","type":"uint128","internalType":"uint128"},{"name":"recipient","type":"address","internalType":"address"},{"name":"referrerFee","type":"uint128","internalType":"uint128"},{"name":"token","type":"address","internalType":"address"}]},{"name":"referrer","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256[]","internalType":"uint256[]"}],"stateMutability":"nonpayable"},{"type":"function","name":"buy","inputs":[{"name":"b","type":"tuple","internalType":"struct Receipt","components":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ReceiptStatus"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"},{"name":"totalPaid","type":"uint128","internalType":"uint128"},{"name":"recipient","type":"address","internalType":"address"},{"name":"referrerFee","type":"uint128","internalType":"uint128"},{"name":"token","type":"address","internalType":"address"}]},{"name":"referrer","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},{"type":"function","name":"cancel","inputs":[{"name":"receiptId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"cancelFeeBps","inputs":[],"outputs":[{"name":"","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},{"type":"function","name":"getPriceAndDiscountRate","inputs":[{"name":"b","type":"tuple[]","internalType":"struct Receipt[]","components":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ReceiptStatus"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"},{"name":"totalPaid","type":"uint128","internalType":"uint128"},{"name":"recipient","type":"address","internalType":"address"},{"name":"referrerFee","type":"uint128","internalType":"uint128"},{"name":"token","type":"address","internalType":"address"}]},{"name":"buyer","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"isAvailable","inputs":[{"name":"dates","type":"tuple","internalType":"struct ReceiptDates","components":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"}]}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"items","inputs":[{"name":"","type":"uint64","internalType":"uint64"}],"outputs":[{"name":"minUnitPrice","type":"uint128","internalType":"uint128"},{"name":"itemType","type":"uint8","internalType":"enum ItemType"},{"name":"transferable","type":"bool","internalType":"bool"},{"name":"unlimited","type":"bool","internalType":"bool"},{"name":"token","type":"address","internalType":"address"},{"name":"manager","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"managerConfigs","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"receiptValidator","type":"address","internalType":"contract IReceiptValidator"}],"stateMutability":"view"},{"type":"function","name":"multicall","inputs":[{"name":"data","type":"bytes[]","internalType":"bytes[]"}],"outputs":[{"name":"","type":"bytes[]","internalType":"bytes[]"}],"stateMutability":"payable"},{"type":"function","name":"ownerOf","inputs":[{"name":"id","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"result","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"receipts","inputs":[{"name":"","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"listingId","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ReceiptStatus"},{"name":"year","type":"uint8","internalType":"uint8"},{"name":"startDay","type":"uint16","internalType":"uint16"},{"name":"daysCount","type":"uint8","internalType":"uint8"},{"name":"totalPaid","type":"uint128","internalType":"uint128"},{"name":"recipient","type":"address","internalType":"address"},{"name":"referrerFee","type":"uint128","internalType":"uint128"},{"name":"token","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"receiptsCounter","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"event","name":"CancelReservation","inputs":[{"name":"receiptId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"recipient","type":"address","indexed":true,"internalType":"address"},{"name":"canceler","type":"address","indexed":true,"internalType":"address"},{"name":"refund","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"cancelFee","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"ConfirmReservation","inputs":[{"name":"receiptId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"recipient","type":"address","indexed":true,"internalType":"address"},{"name":"caller","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},{"type":"event","name":"Fulfill","inputs":[{"name":"receiptId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"recipient","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},{"type":"event","name":"MakePayment","inputs":[{"name":"receiptId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"itemId","type":"uint64","indexed":true,"internalType":"uint64"},{"name":"referrer","type":"address","indexed":true,"internalType":"address"},{"name":"minPurchasePrice","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"totalBidPrice","type":"uint256","indexed":false,"internalType":"uint256"},{"name":"parentReceipt","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"MakeReservation","inputs":[{"name":"receiptId","type":"uint256","indexed":true,"internalType":"uint256"},{"name":"listingId","type":"uint64","indexed":true,"internalType":"uint64"},{"name":"recipient","type":"address","indexed":true,"internalType":"address"},{"name":"year","type":"uint8","indexed":false,"internalType":"uint8"},{"name":"startDay","type":"uint16","indexed":false,"internalType":"uint16"},{"name":"daysCount","type":"uint8","indexed":false,"internalType":"uint8"}],"anonymous":false},{"type":"error","name":"InsufficientReserve","inputs":[{"name":"manager","type":"address","internalType":"address"},{"name":"token","type":"address","internalType":"address"},{"name":"requested","type":"uint256","internalType":"uint256"},{"name":"have","type":"uint256","internalType":"uint256"}]},{"type":"error","name":"InvalidBulkPayment","inputs":[]},{"type":"error","name":"InvalidGuest","inputs":[]},{"type":"error","name":"InvalidReceiptDate","inputs":[]},{"type":"error","name":"InvalidReceiptLength","inputs":[]},{"type":"error","name":"ItemAlreadyReserved","inputs":[]},{"type":"error","name":"ItemNeedsPrice","inputs":[]},{"type":"error","name":"ManagerBanned","inputs":[]},{"type":"error","name":"MixedManagers","inputs":[]},{"type":"error","name":"MixedPaymentTokens","inputs":[]},{"type":"error","name":"ReceiptAlreadyConfirmedOrCanceled","inputs":[]},{"type":"error","name":"ReceiptAlreadyFinalized","inputs":[]},{"type":"error","name":"RecipientBan","inputs":[]},{"type":"error","name":"ReferrerFeeTooHigh","inputs":[]},{"type":"error","name":"Unauthorized","inputs":[]},{"type":"error","name":"YearOutOfRange","inputs":[{"name":"year","type":"uint8","internalType":"uint8"},{"name":"max","type":"uint8","internalType":"uint8"}]}];

const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

// ---------------------------------------------------------------------------
// Config & clients
// ---------------------------------------------------------------------------
const BASE = (process.env.ZUCITY_BASE_URL ?? FACTS.baseUrlDefault).replace(/\/$/, "");
const CHAIN_ID = Number(process.env.ZUCITY_CHAIN_ID ?? "1");
const CHAIN_FACTS = FACTS.chains[CHAIN_ID];
if (!CHAIN_FACTS) {
  console.error(`zucity-mcp: unsupported ZUCITY_CHAIN_ID=${CHAIN_ID} (use 1 or 11155111)`);
  process.exit(1);
}
const RPC = process.env.ZUCITY_RPC_URL ?? CHAIN_FACTS.rpcDefault;
const SYSTEM = getAddress(CHAIN_FACTS.zuCitySystem);
const DEFAULT_REFERRER = process.env.ZUCITY_REFERRER && isAddress(process.env.ZUCITY_REFERRER)
  ? getAddress(process.env.ZUCITY_REFERRER) : zeroAddress;
const UA = "zucity-mcp/0.1.0";
const MAINNET_WARNING = CHAIN_ID === 1
  ? "MAINNET — real funds. Verify chainId=1 and the `to` address before signing."
  : null;

const client = createPublicClient({
  chain: CHAIN_ID === 1 ? mainnet : sepolia,
  transport: http(RPC),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

function parseDateUTC(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`invalid date "${s}" — use YYYY-MM-DD`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(t);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`invalid calendar date "${s}"`);
  }
  return t;
}

/** Encode a stay to contract dates. daysCount is INCLUSIVE calendar days. */
function encodeStay(startDate, endDate) {
  const s = parseDateUTC(startDate);
  const e = parseDateUTC(endDate ?? startDate);
  if (e < s) throw new Error("endDate is before startDate");
  const calYear = new Date(s).getUTCFullYear();
  const year = calYear - FACTS.dateEncoding.epochYear;
  if (year < 0 || year > 255) throw new Error(`year ${calYear} not encodable (epoch ${FACTS.dateEncoding.epochYear})`);
  const startDay = Math.round((s - Date.UTC(calYear, 0, 0)) / DAY_MS); // Jan 1 → 1
  if (startDay > FACTS.dateEncoding.daysPerYear) {
    throw new Error(`startDay ${startDay} exceeds the 364-day contract year — start on/before Dec 30`);
  }
  const daysCount = Math.round((e - s) / DAY_MS) + 1;
  if (daysCount > 255) throw new Error("stays longer than 255 days must be split into multiple receipts");
  return { year, startDay, daysCount, calendar: { startDate, endDate: endDate ?? startDate } };
}

function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

function ok(payload, source) {
  const body = { ...payload, source, asOf: new Date().toISOString() };
  if (MAINNET_WARNING && (source?.type === "chain" || payload.transactions)) body.warning = MAINNET_WARNING;
  return { content: [{ type: "text", text: JSON.stringify(jsonSafe(body), null, 2) }] };
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: msg, docs: "https://github.com/kibagateaux/zucity-api-docs" }) }] };
}

async function jfetch(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (r.status === 429) throw new Error(`rate limited (429) — retry after ${r.headers.get("retry-after") ?? "60"}s (tRPC limit 20/min per IP)`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function trpc(proc, input) {
  const q = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const j = await jfetch(`${BASE}/api/trpc/${proc}${q}`);
  return j?.result?.data?.json ?? null;
}

const read = (functionName, args) =>
  client.readContract({ address: SYSTEM, abi: ZUCITY_ABI, functionName, args });

/** items(id) → named object; tolerates array or object decode shapes. */
async function readItem(listingId) {
  const r = await read("items", [BigInt(listingId)]);
  const a = Array.isArray(r) ? r : [r.minUnitPrice, r.itemType, r.transferable, r.unlimited, r.token, r.manager];
  const [minUnitPrice, itemType, transferable, unlimited, token, manager] = a;
  return {
    listingId: BigInt(listingId), minUnitPrice, itemType: Number(itemType),
    itemTypeLabel: FACTS.enums.itemType[Number(itemType)] ?? String(itemType),
    transferable, unlimited, token: getAddress(token), manager: getAddress(manager),
    applicationGated: minUnitPrice === FACTS.sentinelPrice,
  };
}

/** Positional Receipt tuple for encoding: [listingId,status,year,startDay,daysCount,totalPaid,recipient,referrerFee,token] */
const receiptTuple = (listingId, enc, recipient, token, totalPaid = 0n) =>
  [BigInt(listingId), 0, enc.year, enc.startDay, enc.daysCount, totalPaid, recipient, 0n, token];

function normalizeReceipt(r) {
  const a = Array.isArray(r)
    ? r : [r.listingId, r.status, r.year, r.startDay, r.daysCount, r.totalPaid, r.recipient, r.referrerFee, r.token];
  const [listingId, status, year, startDay, daysCount, totalPaid, recipient, referrerFee, token] = a;
  return {
    listingId, status: Number(status),
    statusLabel: FACTS.enums.receiptStatus[Number(status)] ?? String(status),
    year: Number(year), startDay: Number(startDay), daysCount: Number(daysCount),
    calendarYear: Number(year) + FACTS.dateEncoding.epochYear,
    totalPaid, recipient, referrerFee, token,
  };
}

async function tokenInfo(token) {
  const known = CHAIN_FACTS.paymentToken;
  if (getAddress(token) === getAddress(known.address)) return { address: getAddress(token), ...{ symbol: known.symbol, decimals: known.decimals } };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address: getAddress(token), symbol, decimals: Number(decimals) };
}

/**
 * Shared pipeline: resolve items from chain, validate, group by manager,
 * quote each group. Returns groups with receipts (totalPaid on [0]).
 */
async function resolveAndQuote(items, buyerAddress, recipientAddress) {
  const recipient = getAddress(recipientAddress ?? buyerAddress);
  const buyer = getAddress(buyerAddress ?? recipientAddress);
  const resolved = [];
  for (const it of items) {
    const info = await readItem(it.itemId);
    if (info.applicationGated) {
      throw new Error(
        `item ${it.itemId} is application-gated (sentinel price) and cannot be bought directly — ` +
        `use list_application_forms / send the user to ${BASE}/en/items/${it.itemId}`,
      );
    }
    if (info.minUnitPrice === 0n) throw new Error(`item ${it.itemId} has no onchain price configured`);
    const enc = encodeStay(it.startDate, it.endDate);
    const qty = Math.max(1, Math.trunc(it.quantity ?? 1));
    if (qty > 1 && !info.unlimited) {
      throw new Error(`item ${it.itemId} is a limited listing — book a date range instead of quantity > 1`);
    }
    if (!info.unlimited) {
      const avail = await read("isAvailable", [[info.listingId, enc.year, enc.startDay, enc.daysCount]]);
      if (!avail) throw new Error(`item ${it.itemId} is NOT available for ${it.startDate}..${it.endDate ?? it.startDate}`);
    }
    for (let i = 0; i < qty; i++) resolved.push({ info, enc, request: it });
  }
  // group by manager (bulkBuy constraint); tokens must match within a group
  const groups = new Map();
  for (const r of resolved) {
    const key = r.info.manager;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const quoted = [];
  for (const [manager, members] of groups) {
    const tokens = new Set(members.map((m) => m.info.token));
    if (tokens.size > 1) throw new Error(`manager ${manager} group mixes payment tokens — split the cart (MixedPaymentTokens)`);
    const token = members[0].info.token;
    const receipts = members.map((m) => receiptTuple(m.info.listingId, m.enc, recipient, token));
    const [total, discountBps] = await read("getPriceAndDiscountRate", [receipts, buyer]);
    receipts[0][5] = total; // totalPaid on receipts[0] ONLY
    const tinfo = await tokenInfo(token);
    quoted.push({
      manager, token: tinfo, receipts,
      items: members.map((m) => ({ listingId: m.info.listingId, itemTypeLabel: m.info.itemTypeLabel, dates: m.enc })),
      total, discountBps: Number(discountBps),
      totalFormatted: `${formatUnits(total, tinfo.decimals)} ${tinfo.symbol}`,
    });
  }
  return { quoted, recipient, buyer };
}

// ---------------------------------------------------------------------------
// MCP server & tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "zucity", version: "0.3.0" });

server.tool(
  "search_inventory",
  "Search ZuCity's curated registry (rooms, suites, villas, venues, tickets, memberships…). Discovery layer: price/manager here are display metadata — quote_price is authoritative. Filters are AND-combined.",
  {
    itemtype: z.string().optional().describe("ticket|membership|art|merch|room|suite|villa|venue|equipment or 0-10 (sponsorship=2, service=5 numeric only)"),
    region: z.string().optional(), city: z.string().optional(), community: z.string().optional(),
    capacity: z.number().int().positive().optional(),
    startdate: z.string().optional().describe("YYYY-MM-DD"), enddate: z.string().optional().describe("YYYY-MM-DD"),
    tags: z.string().optional().describe("comma-separated, matches any"),
    paytoken: z.string().optional(), host: z.string().optional(),
    id: z.string().optional().describe("select a single item by id client-side"),
    limit: z.number().int().positive().max(50).optional().describe("trim results (default 20)"),
  },
  async (args) => {
    try {
      const { id, limit, ...filters } = args;
      const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""));
      const data = await jfetch(`${BASE}/api/inventory${qs.size ? `?${qs}` : ""}`);
      let items = data.items ?? [];
      if (id) items = items.filter((i) => String(i.id) === String(id));
      const trimmed = items.slice(0, limit ?? 20).map((i) => ({
        ...i,
        _note: i.externalPurchaseLink || i.price === 0
          ? "application-gated or externally sold — do not build purchase calldata; use the apply/external link"
          : "indicative display price — call quote_price before quoting the user",
      }));
      return ok(
        { count: data.count, returned: trimmed.length, items: trimmed },
        { type: "rest", detail: `GET ${BASE}/api/inventory (cached ~60s; 30 req/min)` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_calendar",
  "Events, reservations, and the CHAIN-DERIVED registry (real onchain prices in token base units, real managers, booked days) over REST. Also serves per-user booking calendars.",
  {
    community: z.string().optional(), city: z.string().optional(),
    type: z.string().optional().describe("csv of item types, e.g. ticket,room"),
    startDate: z.string().optional(), endDate: z.string().optional(),
    userAddress: z.string().optional().describe("0x… — that wallet's bookings"),
  },
  async (args) => {
    try {
      const qs = new URLSearchParams({ format: "json" });
      for (const [k, v] of Object.entries(args)) if (v) qs.set(k === "community" ? "communityName" : k, v);
      const data = await jfetch(`${BASE}/api/calendars?${qs}`);
      return ok(data, { type: "rest", detail: `GET ${BASE}/api/calendars?${qs} — inventory[] is chain-derived truth` });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "check_availability",
  "Authoritative onchain availability for an item and date range (eth_call isAvailable). Unlimited items (tickets/memberships) are always available.",
  {
    itemId: z.union([z.string(), z.number()]).describe("onchain listingId (= inventory id)"),
    startDate: z.string().describe("YYYY-MM-DD"),
    endDate: z.string().optional().describe("YYYY-MM-DD inclusive; defaults to startDate"),
  },
  async ({ itemId, startDate, endDate }) => {
    try {
      const info = await readItem(itemId);
      const enc = encodeStay(startDate, endDate);
      if (info.applicationGated) {
        return ok({ available: false, reason: "application-gated item — use the apply flow", item: info, encodedDates: enc },
          { type: "chain", detail: `${SYSTEM} items(${itemId}) @ chain ${CHAIN_ID}` });
      }
      const available = info.unlimited
        ? true
        : await read("isAvailable", [[info.listingId, enc.year, enc.startDay, enc.daysCount]]);
      return ok(
        { available, unlimited: info.unlimited, item: { listingId: info.listingId, itemTypeLabel: info.itemTypeLabel }, encodedDates: enc },
        { type: "chain", detail: `${SYSTEM} isAvailable((${itemId},${enc.year},${enc.startDay},${enc.daysCount})) @ chain ${CHAIN_ID}` },
      );
    } catch (e) { return fail(e); }
  },
);

const quoteItemsShape = z.array(z.object({
  itemId: z.union([z.string(), z.number()]),
  startDate: z.string().describe("YYYY-MM-DD"),
  endDate: z.string().optional(),
  quantity: z.number().int().positive().max(50).optional().describe("for unlimited items (tickets): receipts per person"),
})).min(1).max(20);

server.tool(
  "quote_price",
  "Authoritative price quote via the contract (getPriceAndDiscountRate) — includes bulk/length/community discounts. ALWAYS use this over inventory display prices. Card price = quote × 1.25.",
  {
    items: quoteItemsShape,
    buyerAddress: z.string().describe("0x… wallet that will pay (discounts can depend on it)"),
  },
  async ({ items, buyerAddress }) => {
    try {
      if (!isAddress(buyerAddress)) throw new Error("buyerAddress must be a 0x address");
      const { quoted } = await resolveAndQuote(items, buyerAddress, buyerAddress);
      const grand = quoted.reduce((s, g) => s + g.total, 0n);
      return ok(
        {
          groups: quoted.map(({ receipts, ...g }) => g),
          grandTotal: grand,
          note: "price in token base units; totalFormatted per group is human-readable. Card checkout price = this × 1.25 (crypto is 20% off card).",
        },
        { type: "chain", detail: `${SYSTEM} getPriceAndDiscountRate @ chain ${CHAIN_ID}` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "build_purchase_calldata",
  "Assemble ready-to-sign transactions for an onchain purchase: ERC20 approval(s) + buy/bulkBuy (or multicall across managers). NEVER signs. Pass referrerAddress (e.g. YOUR wallet) to earn the instant onchain referral split — and disclose it to your principal (skills.md § Acting for a principal).",
  {
    items: quoteItemsShape,
    recipientAddress: z.string().describe("0x… receives the booking receipt NFT(s)"),
    buyerAddress: z.string().optional().describe("0x… payer if different from recipient"),
    referrerAddress: z.string().optional().describe("0x… earns the referral split (default: env ZUCITY_REFERRER or none)"),
  },
  async ({ items, recipientAddress, buyerAddress, referrerAddress }) => {
    try {
      if (!isAddress(recipientAddress)) throw new Error("recipientAddress must be a 0x address");
      if (buyerAddress && !isAddress(buyerAddress)) throw new Error("buyerAddress must be a 0x address");
      const referrer = referrerAddress
        ? (() => { if (!isAddress(referrerAddress)) throw new Error("referrerAddress must be a 0x address"); return getAddress(referrerAddress); })()
        : DEFAULT_REFERRER;
      const { quoted, recipient, buyer } = await resolveAndQuote(items, buyerAddress ?? recipientAddress, recipientAddress);

      // approvals: one per token, summed across groups
      const perToken = new Map();
      for (const g of quoted) {
        const k = g.token.address;
        perToken.set(k, { token: g.token, amount: (perToken.get(k)?.amount ?? 0n) + g.total });
      }
      const approvals = [...perToken.values()].map(({ token, amount }) => ({
        purpose: `approve ${formatUnits(amount, token.decimals)} ${token.symbol} to the booking system contract`,
        transaction: {
          chainId: CHAIN_ID, to: token.address, value: "0",
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [SYSTEM, amount] }),
        },
      }));

      // per-group purchase calls
      const calls = quoted.map((g) => {
        const fn = g.receipts.length === 1 ? "buy" : "bulkBuy";
        const args = g.receipts.length === 1 ? [g.receipts[0], referrer] : [g.receipts, referrer];
        return { fn, data: encodeFunctionData({ abi: ZUCITY_ABI, functionName: fn, args }), group: g };
      });
      const purchase = calls.length === 1
        ? { functionName: calls[0].fn, transaction: { chainId: CHAIN_ID, to: SYSTEM, value: "0", data: calls[0].data } }
        : {
            functionName: "multicall",
            transaction: {
              chainId: CHAIN_ID, to: SYSTEM, value: "0",
              data: encodeFunctionData({ abi: ZUCITY_ABI, functionName: "multicall", args: [calls.map((c) => c.data)] }),
            },
          };

      // round-trip decode echo (self-check against silent encoding bugs)
      const echoTarget = calls.length === 1 ? purchase.transaction.data : calls[0].data;
      const decoded = decodeFunctionData({ abi: ZUCITY_ABI, data: echoTarget });
      const grand = quoted.reduce((s, g) => s + g.total, 0n);

      return ok(
        {
          summary: `${quoted.reduce((n, g) => n + g.receipts.length, 0)} receipt(s) across ${quoted.length} manager group(s); pay ${quoted.map((g) => g.totalFormatted).join(" + ")}; recipient ${recipient}; referrer ${referrer === zeroAddress ? "none (you may pass your own address — it earns a fee; disclose it to your principal)" : `${referrer} (earns a referral fee — disclose it to your principal)`}`,
          steps: ["1) sign each approval transaction", "2) sign the purchase transaction", "3) receipt ids arrive in MakeReservation events; booking starts as Pending until confirmed"],
          approvals,
          purchase,
          groups: quoted.map(({ receipts, ...g }) => ({ ...g, receiptsEncoded: receipts })),
          grandTotal: grand,
          buyer,
          decodedEcho: { functionName: decoded.functionName, firstArg: decoded.args?.[0] },
          docs: "https://github.com/kibagateaux/zucity-api-docs/blob/main/contracts.md",
        },
        { type: "chain", detail: `encoded against ${SYSTEM} @ chain ${CHAIN_ID}; ABI verbatim from source (${GENERATED_FROM})` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_receipt_status",
  "Look up bookings from chain truth: by receiptId, or all receipts for a recipient wallet.",
  {
    receiptId: z.union([z.string(), z.number()]).optional(),
    recipient: z.string().optional().describe("0x… list this wallet's receipts"),
  },
  async ({ receiptId, recipient }) => {
    try {
      if (receiptId === undefined && !recipient) throw new Error("provide receiptId or recipient");
      if (receiptId !== undefined) {
        const r = normalizeReceipt(await read("receipts", [BigInt(receiptId)]));
        return ok({ receipt: r }, { type: "chain", detail: `${SYSTEM} receipts(${receiptId}) @ chain ${CHAIN_ID}` });
      }
      if (!isAddress(recipient)) throw new Error("recipient must be a 0x address");
      const MAX_U64 = 18446744073709551615n;
      const list = await read("allReceipts", [0n, [MAX_U64], getAddress(recipient), 255]);
      return ok(
        { count: list.length, receipts: list.map(normalizeReceipt) },
        { type: "chain", detail: `${SYSTEM} allReceipts(recipient=${recipient}) @ chain ${CHAIN_ID}` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "list_application_forms",
  "Application forms for gated listings (residencies, registries, contributor rooms), via REST. Submission requires login at zucity.org — this tool returns the questions plus the no-code apply URL.",
  { slug: z.string().optional().describe("form slug for full questions; omit to list all"), locale: z.string().optional() },
  async ({ slug, locale }) => {
    try {
      if (!slug) {
        const forms = await trpc("form.listActive", { locale: locale ?? "en" });
        return ok(
          { forms: (forms ?? []).map((f) => ({ slug: f.slug, title: f.title, description: f.description, purpose: f.purpose, applyUrl: `${BASE}/en/apply/${f.slug}` })) },
          { type: "rest", detail: `tRPC form.listActive @ ${BASE}` },
        );
      }
      const form = await trpc("form.getBySlug", { slug, locale: locale ?? "en" });
      if (!form) throw new Error(`no form with slug "${slug}"`);
      return ok(
        {
          slug: form.slug, title: form.title, description: form.description,
          applyUrl: `${BASE}/en/apply/${form.slug}`,
          questionCount: (form.questions ?? []).length,
          questions: (form.questions ?? []).slice(0, 100).map((q) => ({
            id: q.id, label: q.label, fieldType: q.fieldType, isRequired: q.isRequired,
            options: q.options ?? undefined, dependsOnQuestionId: q.dependsOnQuestionId ?? undefined,
          })),
          submitNote: "programmatic submission = tRPC form.submit with a Privy JWT (see api.md); otherwise use applyUrl",
        },
        { type: "rest", detail: `tRPC form.getBySlug @ ${BASE}` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "booking_link",
  "Static URL builder: shareable zucity.org links (item pages, apply pages, referral landing). Append your referral code to monetize conversions — and disclose it to your principal (skills.md § Acting for a principal).",
  {
    itemId: z.union([z.string(), z.number()]).optional(),
    formSlug: z.string().optional(),
    ref: z.string().regex(/^[a-zA-Z0-9_-]{3,30}$/, "referral codes are usernames: 3-30 chars [a-zA-Z0-9_-]").optional(),
    locale: z.enum(["en", "ja"]).optional(),
  },
  async ({ itemId, formSlug, ref, locale }) => {
    try {
      const l = locale ?? "en";
      let url;
      if (itemId !== undefined) url = `${BASE}/${l}/items/${itemId}`;
      else if (formSlug) url = `${BASE}/${l}/apply/${formSlug}`;
      else url = `${BASE}/${l}`;
      if (ref) url += `?ref=${encodeURIComponent(ref)}`;
      return ok(
        { url, note: ref ? "conversions on this link attribute to your referral code (earn points toward exclusive member rewards; onchain splits use the referrer address in buy/bulkBuy instead)" : "no ref code attached" },
        { type: "static", detail: "URL patterns live-verified 2026-07-03" },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_reviews",
  "Public review data for a registry item: aggregate rating (note.getReviewAggregation) plus individual reviews (note.getByReview). REST social proof from member identities — display metadata, not chain truth.",
  { itemId: z.union([z.string(), z.number()]).describe("registry item id (= reviewId)") },
  async ({ itemId }) => {
    try {
      const id = String(itemId);
      const [aggregation, reviews] = await Promise.all([
        trpc("note.getReviewAggregation", { reviewId: id }),
        trpc("note.getByReview", { reviewId: id }),
      ]);
      return ok(
        { itemId: id, aggregation, reviews: reviews ?? [], note: "one review per member per item, rating 1-5; zeroed aggregation = no reviews yet" },
        { type: "rest", detail: `tRPC note.getReviewAggregation + note.getByReview @ ${BASE}` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "resolve_referral_code",
  "REST lookup: resolve a referral code (username) via referral.resolveCode — returns {id, username, avatarUrl} or null when unknown. Validate a code before attaching it to links or checkouts.",
  { code: z.string().regex(/^[a-zA-Z0-9_-]{3,30}$/, "referral codes are usernames: 3-30 chars [a-zA-Z0-9_-]") },
  async ({ code }) => {
    try {
      const profile = await trpc("referral.resolveCode", { code });
      return ok(
        { code, resolved: profile !== null, profile },
        { type: "rest", detail: `tRPC referral.resolveCode @ ${BASE}` },
      );
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_facts",
  "Ground-truth card: chain addresses, enums, encoding rules, rate limits, verified NOT-SUPPORTED list. Cite this instead of guessing.",
  {},
  async () => ok(
    { activeChainId: CHAIN_ID, activeChain: CHAIN_FACTS, system: SYSTEM, rpc: RPC, baseUrl: BASE, facts: FACTS, generatedFrom: GENERATED_FROM },
    { type: "static", detail: "embedded facts (regenerated per release)" },
  ),
);

// ---------------------------------------------------------------------------
// Selftest (npm run smoke) — proves live REST + chain + encoding in one shot
// ---------------------------------------------------------------------------
async function selftest() {
  const results = [];
  const step = async (name, fn) => {
    try { const v = await fn(); results.push([name, "OK", v]); }
    catch (e) { results.push([name, "FAIL", e.message]); }
  };
  await step("REST /api/inventory", async () => {
    const d = await jfetch(`${BASE}/api/inventory?itemtype=room&capacity=2`);
    return `${d.count} rooms`;
  });
  await step("chain items(1)", async () => {
    const i = await readItem(1);
    return `${i.itemTypeLabel} @ ${formatUnits(i.minUnitPrice === FACTS.sentinelPrice ? 0n : i.minUnitPrice, (await tokenInfo(i.token)).decimals)} ${(await tokenInfo(i.token)).symbol}`;
  });
  await step("date encoding", () => {
    const e = encodeStay("2026-05-01", "2026-05-31");
    if (e.year !== 3 || e.startDay !== 121 || e.daysCount !== 31) throw new Error(JSON.stringify(e));
    return "2026-05-01+31d → (3,121,31) ✓ (deterministic from the encoding)";
  });
  await step("tRPC form.listActive", async () => {
    const f = await trpc("form.listActive", { locale: "en" });
    return `${f?.length ?? 0} forms`;
  });
  await step("tRPC reviews", async () => {
    const agg = await trpc("note.getReviewAggregation", { reviewId: "18" });
    if (!agg || !Array.isArray(agg.distribution)) throw new Error(`unexpected aggregation shape: ${JSON.stringify(agg)}`);
    return `item 18: ${agg.totalReviews} reviews`;
  });
  for (const [name, status, info] of results) console.error(`${status.padEnd(4)} ${name}: ${info}`);
  const failed = results.some(([, s]) => s === "FAIL");
  console.error(failed ? "SMOKE: FAIL" : `SMOKE: OK (chain ${CHAIN_ID}, ${BASE})`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`zucity-mcp ready — chain ${CHAIN_ID} (${CHAIN_FACTS.role}), base ${BASE}`);
}
