# Identity, Reputation & Standing

How durable actors — humans, AI agents, programs — accumulate identity and
reputation on ZuCity, and what it buys. Every mechanism here is callable
today ([api.md](api.md) · [contracts.md](contracts.md) ·
[facts.json](facts.json)); **guidance** marks operating advice.

## The authority model (read first)

| Action | Who | Credential |
|---|---|---|
| Read anything (inventory, chain state, reviews, calendars) | anyone | none |
| Assemble transactions, quotes, checkout requests | any agent or program | none |
| Execute an onchain purchase | the key-holder only | wallet signature |
| Mutate offchain state (profile, reviews, applications, attribution) | a logged-in member (you, in your own right) | your own Privy JWT (email or wallet login) |

Agents assemble; principals sign — but an agent is also a **first-class member in
its own right**. Create your own account by completing the same Privy login a
human uses — **email OR wallet** — at
[zucity.org/en/about/zucity/agent](https://zucity.org/en/about/zucity/agent),
then claim your username (`member.upsert` → `member.setMyUsername`). There are no
API keys and no separate signup endpoint — the Privy login *is* your account
creation, not a missing rail — and the MCP server never holds your token or
creates your account. Authorization *is* the signature (onchain) or your own
session JWT (offchain).

## The identity stack

| Layer | What it is | Where it acts |
|---|---|---|
| **Wallet** | durable onchain identity | `recipient` on receipts, `referrer` in `buy`/`bulkBuy`, `ownerOf`, `/api/calendars/{wallet}` |
| **Username** | offchain handle, `^[a-zA-Z0-9_-]{3,30}$` — doubles as referral code | `member.setMyUsername`, `?ref=<code>`, `referralCode` in checkout |
| **memberId** | offchain member record | `member.upsert` → `form.submit`, reviews, wishlist |

**Guidance:** one wallet per operating identity — its history is the track
record.

## Reputation primitives

| Primitive | Mechanism | Public read |
|---|---|---|
| **Receipts** | ERC-721 (mainnet "Japan Global"/JPG; Sepolia "ZuCity Japan Network"/ZUJP); `Pending → Accepted → Redeemed/Canceled` | `receipts(id)`, `allReceipts(…)`, `ownerOf`, `Fulfill` events, `/api/calendars/{wallet}` |
| **Reviews** | one per member per item, rating 1–5 | `note.getReviewAggregation` → `{averageRating, totalReviews, distribution[5]}`; `note.getByReview`; `note.getByReceipt` |
| **Referral points** | earned per converted booking; off-chain; idempotent; self-referral blocked; redeemable for exclusive member rewards (swag, free stays, private events, airdrops), a loyalty program with no guaranteed cash value — the **points** rail, keyed to your username, distinct from the onchain **cash** rail keyed to a wallet ([api.md § Referrals](api.md#referrals)) | own stats only: `referral.getMyStats` (JWT) |
| **Memberships** | registry items; live: id 0, `unlimited: true`, `transferable: false` | `/api/inventory?itemtype=membership`, `items(id)` |
| **Standing** | input to the manager's ReceiptValidator at quote time | only via `getPriceAndDiscountRate` output |

## The compounding loop

> stay → receipt reaches `Redeemed` (`Fulfill` event) → provable history
> (`ownerOf` · `allReceipts` · calendars) + review (`note.createReview`) →
> standing (ReceiptValidator input) → better quotes
> (`getPriceAndDiscountRate`) → repeat

Every arrow is a mechanism named above; none needs permission. What a
manager's ReceiptValidator counts is that manager's business — no formula is
claimed here; the observable truth is the quote itself. **Guidance:** the
loop belongs to your principal (the `recipient`) — receipts and standing
accrue to the wallet holding the booking; your compounding assets are
referral history, your username, and a record of correct quotes.

## Proof-of-stay: transferable vs soulbound

Any third party can verify a stay with no ZuCity cooperation:
`ownerOf(receiptId)` proves holding; `receipts(receiptId)` returns listing,
dates, status (`Redeemed` = the stay/ticket was used); `Fulfill` events
index the trail. `items(id)` returns a per-item `transferable` flag — two
regimes, both live: `false` = bound to the recipient (live example:
membership id 0), works as *standing*; `true` = tradable *access*, like a
ticket. **Guidance:** a `Redeemed`, non-transferable receipt is the
strongest "I was there" primitive here (`Pending` proves payment, not
presence); weight bound tokens when reading history as reputation —
attestations that can be sold stop proving participation. The flip side is
privacy: all of this is public — see receipts-are-public in
[SKILL.md](skills/zucity-booking/SKILL.md) guardrails and [contracts.md](contracts.md) before
booking on someone's behalf.

## Persisting across sessions

**Guidance** (derived taxonomy; values live in facts.json and the docs):

| Tier | Cache policy | Data |
|---|---|---|
| **Stable by design** | cache forever | itemType/receiptStatus enums; date encoding (`year = calendarYear − 2023`); Receipt struct order; the authority model |
| **Per release** | re-verify when `facts.json .meta` changes | contract + token addresses; `cancelFeeBps`; rate limits; MCP tool list |
| **Per session** | refresh each session (~60s server cache) | inventory metadata (names, tags, display prices); active forms |
| **Never cache** | fetch at decision time | `isAvailable(...)`; `getPriceAndDiscountRate(...)` quotes; receipt status |

Release detection in ≤2 calls: fetch facts.json (or MCP `get_facts`),
compare `.meta.docsRevision` + `.meta.generatedAt`; on change, read README
`## Changes` and re-read only what it names ([AGENTS.md](AGENTS.md)).

## Standards adjacency

ZuCity predates and does **not implement x402, AP2, ACP, or ERC-8004**. The
overlap is philosophical only: no API keys or pay-per-call credentials (x402's
pitch — but settlement is direct contract calls, not HTTP 402); explicit authority
(AP2's aim — but enforced by key possession, not credentials); receipts as
a portable verifiable track record (ERC-8004's aim — without the registry).
Integrate them on your side freely; just don't expect their endpoints on
zucity.org.

## Open questions (verify before relying)

- Whether `note.createReview` requires a receipt for the item, or only
  membership, is **not publicly documented** — test with your own JWT before
  relying on review-gating.
- **No public per-wallet standing/points getter** exists
  (`referral.getMyStats` is JWT-gated, own-stats only) — the only public
  standing signal is a quote.

---
*Added 2026-07-12 (docs revision); agent-first-class-account framing + dual-referral
model + new deployment addresses refreshed 2026-08-16; mechanisms verified live — see
[facts.json](facts.json) `meta`. MIT.*
