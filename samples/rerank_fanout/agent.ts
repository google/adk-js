/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rerank fan-out: one bounded question per candidate, asked in parallel
 *
 * A search a keyword index cannot answer — "that thing about the refund", where
 * the page is titled "Order #48213 — Return authorization" — has to be settled
 * by a model. The obvious way is to hand the model every candidate at once and
 * ask which match. That is the version to avoid: the prompt grows with the
 * corpus, and a comparative judgement across many documents is the kind of
 * question models are least reliable on.
 *
 * This sample does the other thing. Each candidate becomes its own node, and
 * each is asked a single bounded question: here is one page, score it 0-3 and
 * say why in a few words. A `JoinNode` waits for all of them and hands the
 * verdicts to a ranking node. The prompt stays the same size however many
 * candidates there are, one bad verdict cannot drag the others with it, and the
 * calls overlap.
 *
 * Two details carry most of the value:
 *
 *  - **Every scorer shares the identical instruction.** The candidate travels
 *    in the user turn, appended by `beforeModelCallback`, not in the
 *    instruction. Putting the page in the instruction is the obvious first
 *    attempt and gives every scorer a different system prompt. Against a hosted
 *    model that costs prompt cache hits; against an on-device model it is far
 *    worse, since adapters key their warm session on the system prompt and a
 *    new one means a full session creation per candidate.
 *  - **The verdict is schema-constrained**, so the join receives data to sort
 *    rather than prose to parse.
 *
 * The candidates are fixed here so the sample is self-contained. In a real
 * pipeline a cheap deterministic prefilter (BM25 or similar) picks them first,
 * and every candidate it eliminates is an inference call that never happens.
 *
 * Requires an API key. Set GEMINI_API_KEY, then:
 *   npm run sample -- samples/rerank_fanout/agent.ts
 * Ask for something obliquely, e.g. "that thing about the refund".
 */

import {JoinNode, LlmAgent, node, NodeContext, Workflow} from '@google/adk';
import {z} from 'zod';

/** A page already shortlisted by a cheap keyword prefilter. */
interface Candidate {
  /** Used to build the node name, so it must be a valid identifier. */
  id: string;
  title: string;
  url: string;
  /** The part of the page worth showing the model. */
  text: string;
}

const CANDIDATES: Candidate[] = [
  {
    id: 'order_48213',
    title: 'Order #48213 — Return authorization',
    url: 'https://shop.example.com/orders/48213/return',
    text: 'Your return has been authorised. Ship the item back within 30 days and the amount goes back to your original payment method.',
  },
  {
    id: 'invoice_march',
    title: 'Invoice — March',
    url: 'https://billing.example.com/invoices/march',
    text: 'Amount due 412.00, payable by the end of the month. Late payments accrue interest at 1.5% monthly.',
  },
  {
    id: 'flight_booking',
    title: 'Booking confirmed — LHR to SFO',
    url: 'https://air.example.com/booking/QX7T2',
    text: 'Departure 09:55 from Heathrow Terminal 5. Changes permitted up to 24 hours before departure for a fee.',
  },
  {
    id: 'kubernetes_docs',
    title: 'Horizontal Pod Autoscaling',
    url: 'https://kubernetes.example.com/docs/hpa',
    text: 'The autoscaler adjusts replica count based on observed CPU utilisation or custom metrics.',
  },
];

/**
 * The same instruction for every scorer. Nothing candidate-specific belongs
 * here — see the note at the top of the file.
 */
const SCORER_INSTRUCTION = [
  "You judge whether one page answers the user's search.",
  'You are shown the search, then a single page.',
  'Score it: 0 unrelated, 1 weak, 2 close, 3 exactly what they meant.',
  'The words need not overlap. Judge what the page is about.',
  'Explain in twelve words or fewer.',
].join('\n');

/** What each scorer returns, so the join gets data rather than prose. */
const VERDICT = z.object({
  score: z.number().describe('0 unrelated, 1 weak, 2 close, 3 exact.'),
  why: z.string().describe('Twelve words or fewer.'),
});

type Verdict = z.infer<typeof VERDICT>;

/** Renders one candidate as the user turn appended for its scorer. */
function candidateTurn(candidate: Candidate): string {
  return [
    'Page under review:',
    `title: ${candidate.title}`,
    `url: ${candidate.url}`,
    `text: ${candidate.text}`,
  ].join('\n');
}

function scorerFor(candidate: Candidate) {
  return node(
    new LlmAgent({
      name: `score_${candidate.id}`,
      model: 'gemini-flash-latest',
      description: `Scores "${candidate.title}" against the search.`,
      instruction: SCORER_INSTRUCTION,
      beforeModelCallback: ({request}) => {
        // Append rather than replace: the user's search stays, and this
        // scorer's candidate is added after it. The instruction is untouched,
        // so every scorer presents the same system prompt.
        request.contents = [
          ...(request.contents ?? []),
          {role: 'user', parts: [{text: candidateTurn(candidate)}]},
        ];
        return undefined;
      },
      outputSchema: VERDICT,
    }),
    {name: `score_${candidate.id}`},
  );
}

const scorers = CANDIDATES.map(scorerFor);

/** Waits for every scorer, then hands on a record keyed by node name. */
const collect = new JoinNode({name: 'collect_verdicts'});

const rank = node(
  (_ctx: NodeContext, verdicts: Record<string, Verdict | undefined>) => {
    const rows = CANDIDATES.map((candidate) => ({
      candidate,
      verdict: verdicts[`score_${candidate.id}`],
    }))
      // A scorer that completed without an output releases the join anyway and
      // arrives as undefined, so treat a missing verdict as "no match" rather
      // than reading a field off it.
      .filter((row) => (row.verdict?.score ?? 0) > 0)
      .sort((a, b) => (b.verdict?.score ?? 0) - (a.verdict?.score ?? 0));

    if (!rows.length) return 'Nothing matched.';
    return rows
      .map(
        ({candidate, verdict}) =>
          `${verdict?.score}  ${candidate.title}\n   ${verdict?.why}`,
      )
      .join('\n');
  },
  {name: 'rank'},
);

export const rootAgent = new Workflow({
  name: 'rerank_fanout',
  // One edge row per scorer, all converging on the join.
  edges: [
    ...scorers.map((scorer) => ['START' as const, scorer, collect]),
    [collect, rank],
  ],
});
