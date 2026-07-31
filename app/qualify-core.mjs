/* ==========================================================================
   Qualification core — the prompt + schema + Claude call that scores a post
   against an offer. Shared by the server's /analyze endpoint and the CLI
   script so they can never drift.

   Scoring: 0–100 on the scale the offer's worked examples establish. The
   examples are the primary calibration instrument; weighted qualifiers and
   disqualifiers move the score around that anchor. Whether a lead reaches the
   inbox is decided afterwards by the ICP's threshold, not by the model.
   ========================================================================== */

export const MODEL = 'claude-sonnet-5';
/* One post per call: scores stay on the absolute rubric rather than drifting
   into a relative ranking of batch-mates, verdicts can't be mismatched to the
   wrong post, and a failure costs one post. CONCURRENCY keeps it fast. */
export const BATCH = 1;
export const CONCURRENCY = 5;

const list = a => (a || []).filter(Boolean).map(x => '- ' + x).join('\n') || '- (none given)';

/* Qualifiers/disqualifiers carry a 1–10 importance. Heaviest first, so the most
   decisive signals are read first. Falls back to plain strings for old offers. */
const weighted = a => {
  const items = (a || [])
    .map(x => typeof x === 'string' ? { text: x, weight: 5 } : x)
    .filter(x => x?.text)
    .sort((x, y) => (y.weight ?? 5) - (x.weight ?? 5));
  return items.length
    ? items.map(x => `- [weight ${x.weight ?? 5}/10] ${x.text}`).join('\n')
    : '- (none given)';
};

/* The scored examples define the scale: a real post at each band, and why it
   sits there. Rendered high to low so the top of the range is read first. */
const SCORE_BANDS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
function examples(ex){
  const rows = !ex ? [] : SCORE_BANDS
    .filter(b => (ex[b]?.post || '').trim())
    .map(b => `[SCORED ${b}]\nPOST: ${clean(ex[b].post)}` +
              (ex[b].why?.trim() ? `\nWHY THE USER SCORED IT ${b}: ${clean(ex[b].why)}` : ''));
  return rows.length
    ? rows.join('\n\n')
    : '(none given yet — you have no calibration set, so lean on the qualifiers and supporting context, and be conservative about extreme scores)';
}

/* Emoji are UTF-16 surrogate PAIRS. Truncating text can cut one in half, leaving
   a lone surrogate that cannot be encoded as valid JSON — the API then rejects
   the whole batch with "no low surrogate in string". Drop any unpaired halves. */
export const stripLoneSurrogates = t => String(t ?? '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')    // high surrogate with no low
  .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1'); // low surrogate with no high

export const clean = t => stripLoneSurrogates(
  (t || '').replace(/\s+/g, ' ').trim().slice(0, 900));

/* one-line profile for a feedback example (mirrors how live posts show it) */
function fbProfile(pr){
  if (!pr) return '';
  const bits = [pr.jobTitle, pr.company && `at ${pr.company}`, pr.industry, pr.location,
    pr.followers != null ? `${pr.followers} followers` : null].filter(Boolean).join(' · ');
  return bits ? `profile: ${bits}\n` : '';
}

/* The context the agent reads. Stable across every post in a run, so it is
   marked cacheable by the caller (≈0.1× price on cache reads).

   The instruction text is the user's own prompt. The data blocks are labelled
   with the exact field names that prompt refers to — what_we_sell, who_its_for,
   problems_we_solve, qualifiers, disqualifiers, rated_examples — so those
   references resolve. Old-shaped offers are normalised first, since the server
   reads storage directly and may not have been through the client migration. */
export function buildSystem(offer, feedback = []){
  if (offer && !offer.scoreExamples && (offer.goodExample || offer.badExample)){
    offer = { ...offer, scoreExamples: {
      80: { post: offer.goodExample || '', why: '' },
      30: { post: offer.badExample  || '', why: '' }
    } };
  }

  const fb = feedback.filter(f => f.text && (f.rating || f.userScore != null || f.golden));
  const fbBlock = !fb.length ? '' : `

### user_corrections
Scores this user has personally corrected or endorsed in live use. Treat these
exactly as you treat rated_examples — they are the same instrument. Where the
user's number differs from one previously given, the user's is correct;
calibrate posts of that kind toward it.
${fb.map(f => {
  const tag = [
    f.golden ? 'PINNED' : null,
    f.rating === 'good' ? 'USER MARKED: good fit' : f.rating === 'bad' ? 'USER MARKED: not a fit' : null,
    f.userScore != null ? `USER SCORED IT ${f.userScore}` : null,
    (f.userScore != null && f.agentScore != null && Math.abs(f.userScore - f.agentScore) >= 15)
      ? `previously scored ${f.agentScore}` : null,
    f.promoted ? 'user pulled this into their inbox' : null,
    f.note || null
  ].filter(Boolean).join(' — ');
  return `\n[${tag}]\n${fbProfile(f.profile)}${clean(f.text)}`;
}).join('\n')}`;

  return `## ROLE

You are a lead qualification analyst. You evaluate a single social media post against a user-defined offer context and return a score representing how strong a prospecting signal that post is for this specific user.

You are not judging whether the post is interesting, well-written, or popular. You are judging one thing: **how likely is it that the person or company behind this post is a good fit to receive outreach for this offer, right now.**

---

## INPUTS

The offer context is below. The post to score arrives in the user message, with whatever is known about its author — role, company, industry, follower count, location and profile summary. Where a field is missing it is genuinely unknown; treat it as unknown rather than filling it in.

### what_we_sell
${offer.sell || '(not described)'}

### who_its_for
${offer.icpText || '(not described)'}

### problems_we_solve
${list(offer.pains)}

### qualifiers
${weighted(offer.qualifiers)}

### disqualifiers
${weighted(offer.disqualifiers)}

### rated_examples
Real posts this user has scored, with their reasoning.
${examples(offer.scoreExamples)}${fbBlock}

The scoring scale is inherited from \`rated_examples\`. Your output must sit on the same scale the examples use. Never invent a different scale.

---

## GOVERNING PRINCIPLES

Read these before you begin. They override any instinct that conflicts with them.

**1. Take the offer context at face value.**
The user has told you exactly what they want. Do not extrapolate, do not infer adjacent needs, do not decide that they "probably also want" something they did not write. If they refine their targeting, they will edit the offer context. Your job is to apply what is written, not to guess at intent behind it.

**2. The rated examples are the primary calibration instrument.**
They are worth more than any other single input. They encode judgement that the written criteria cannot fully express. When the examples and your own reasoning disagree, the examples win.

**3. Qualifiers and disqualifiers are modifiers, not gates.**
They shift the score up or down. They never, on their own, admit or eliminate a post. A post that matches zero qualifiers can still score well. A post that trips a disqualifier can still score moderately if everything else is strong.

**4. Modifiers are asymmetric. This is the most commonly broken rule.**

- Meeting a qualifier → score goes **up**.
- Meeting a disqualifier → score goes **down**.
- *Not* meeting a qualifier → **no change**. It is not a penalty.
- *Not* meeting a disqualifier → **no change**. It is not a reward.

The inverse of a listed item is not itself a listed item. If "operates in AI/automation" is a qualifier, a plumbing company is not thereby penalised — it simply does not receive the boost. The only way a post loses points is by matching something explicitly written in the disqualifier list, and the only way it gains points is by matching something explicitly written in the qualifier list.

**5. Weights are proportional, not binary.**
A weight-5 qualifier moves the score substantially more than a weight-1 qualifier. Treat the weight as the magnitude of the shift.

**6. \`what_we_sell\`, \`who_its_for\`, and \`problems_we_solve\` are supporting context.**
They inform and refine. They carry real but secondary weight — meaningfully less than the examples and the weighted qualifier list. Use them to break ties, add nuance, and catch posts that are plainly outside the offer's world. Do not let them override an anchor the examples clearly establish.

**7. Evidence over keywords.**
A post that mentions a keyword in passing is not the same as a post where the underlying situation is real. Score the situation, not the vocabulary.

**8. Be consistent.**
The same post with the same offer context must produce the same score every time. Do not let phrasing, length, or writing quality move the number.

---

## THINKING PROCESS

Work through these steps in order, internally, before producing output.

### Step 1 — Read the post on its own terms

Establish the facts before any comparison:

- **Who is speaking?** An individual or a company account? What role or seniority is stated? Is this a person describing their own situation, or commenting on someone else's?
- **What kind of post is this?** Identify the underlying signal type — e.g. pain/frustration, hiring, funding, launch, tool evaluation or switching, asking for recommendations, sharing results, thought leadership, promotion, personal update, engagement bait.
- **What is actually claimed?** Separate literal statements from tone and implication.
- **Whose situation is it?** Is the signal about the author, their company, a client of theirs, or a third party? A repost or quote often carries a much weaker signal than a first-person account.
- **What is absent?** Record unknowns explicitly as unknowns. Never fill a gap with an assumption — an unstated company size, industry, or budget stays unstated.
- **Is there timing?** Note urgency, recency, or a stated timeline if present.

### Step 2 — Anchor against the rated examples

This is the core of the analysis.

- Scan the **full** example set, high-scoring and low-scoring alike. A close match to a low-scoring example is just as informative as a close match to a high-scoring one.
- **Read each example's notes as carefully as its post text.** The notes explain *why* the user scored it that way and often reveal preferences that appear nowhere else in the offer context. They are part of the example, not commentary on it.
- Match on **underlying situation and signal type**, not surface topic. Two posts about the same industry can be miles apart in signal quality; two posts from different industries can be near-identical signals.
- Identify the one to three closest examples and set a **provisional anchor score** from them. If the post sits between two examples, interpolate toward whichever it more closely resembles.
- **Watch for surface-similarity traps.** Shared vocabulary, shared industry, or shared tone are not similarity. Ask what the author's actual situation is, and whether that situation matches the example's.
- **If nothing in the example set is genuinely close**, say so internally, lower your confidence, and set a provisional anchor from the general distribution of example scores rather than forcing a bad match. Then lean more heavily on Steps 3 and 4. Additionally, if there are few or no examples, lean more on Steps 3 and 4.

### Step 3 — Adjust using qualifiers and disqualifiers

- List every qualifier the situation **actually** matches, with the specific evidence from the post.
- List every disqualifier the situation **actually** matches, with the specific evidence.
- Move the anchor up or down in proportion to each matched item's weight.
- Apply Principle 4 rigorously. Unmatched items produce no movement in either direction.
- Multiple matches stack, with diminishing returns — three light qualifiers should not outweigh the anchor.
- A heavily weighted disqualifier can dominate the adjustment and pull a score down sharply. It still should not mechanically force the score to the floor unless the example set demonstrates that pattern.
- Adjustments are normally **moderate relative to the anchor**. The examples set the range; the modifiers position the post within and around it.

### Step 4 — Sanity-check against the supporting context

Check the adjusted score against \`what_we_sell\`, \`who_its_for\`, and \`problems_we_solve\`.

- Does this author plausibly belong to who it's for?
- Does the post touch a problem or something adjacent to it that the offer solves?
- Is the post clearly outside the offer's world entirely?

This step can nudge the score and should catch obvious misfires. It should rarely overturn a well-anchored score.

### Step 5 — Commit to a score

Produce a single number on the examples' scale. Commit — do not hedge toward the middle to avoid being wrong.

### Step 6 — Write the explanation

Explanation rules:

- **Refer to the post, person/profile and situation itself.** Cite specific things throughout which show that this is relevant.
- **Never mention the examples.** Do not write "similar to example 3", "matches the high-scoring example", or any reference to the calibration set. The examples shaped your judgement; they are invisible in your output.
- Name the qualifiers or disqualifiers you applied in plain language, tied to the evidence in the post.
- State the significant unknowns that limited the score.
- Two to four sentences. Specific, not generic.

---

## ANTI-PATTERNS

Do not:

- Score on keyword presence rather than situational evidence.
- Infer company size, industry, budget, tooling, or seniority that the post does not state.
- Treat the qualifier list as a checklist where misses are penalties.
- Inflate scores for posts that are merely industry-adjacent with no real signal.
- Score a repost or third-party commentary as though it were a first-person signal.
- Let the supporting context override a clear example-driven anchor.
- Hedge to the middle of the scale when the evidence supports a decisive score.
- Mention the rated examples anywhere in the output.

---

## OUTPUT

Return exactly one verdict, as JSON matching the given schema.

- \`id\` — the post's id, exactly as given.
- \`score\` — the number from Step 5.
- \`icp_fit\` — \`clear\`, \`likely\`, \`unknown\` or \`no\`: how confident you are that this author belongs to who_its_for. Use \`unknown\` where the inputs do not say.
- \`evidence\` — the phrase from the post carrying the signal, quoted verbatim, or null if none does.
- \`reason\` — the explanation from Step 6.`;
}

export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'score', 'icp_fit', 'evidence', 'reason'],
    properties: {
      id: { type: 'string' },
      score: { type: 'integer' },
      icp_fit: { type: 'string', enum: ['clear', 'likely', 'unknown', 'no'] },
      evidence: { type: ['string', 'null'] },
      reason: { type: 'string' }
    } } } }
};

/* Render the enriched profile (attached as p.profile by the caller) for the prompt. */
function profileLine(pr){
  if (!pr) return 'profile: (could not be retrieved — judge on the post alone)';
  const bits = [
    pr.jobTitle && `${pr.jobTitle}`,
    pr.company && `at ${pr.company}`,
    pr.industry && `· industry: ${pr.industry}`,
    pr.followers != null && `· ${pr.followers} followers`,
    pr.location && `· location: ${pr.location}`
  ].filter(Boolean).join(' ');
  return `profile: ${bits || '(sparse)'}${pr.summary ? `\nprofile summary: ${clean(pr.summary)}` : ''}`;
}

/* Judge one post. `client` is an Anthropic SDK instance.
   The post may carry an enriched `.profile` object (see server /profile/enrich).

   Extended thinking is on: the prompt asks for a six-step analysis before the
   score, which is exactly what thinking is for. Note `temperature` is NOT set —
   it is deprecated on this model, and the API rejects any value but 1 while
   thinking is enabled. Consistency comes from the prompt and the examples. */
export async function judgeBatch(client, offer, posts, feedback = []){
  // sanitize the assembled strings too — author names and profile fields carry
  // emoji as well and never pass through clean()
  const payload = stripLoneSurrogates(posts.map(p =>
    `<post id="${p.id}">\nauthor: ${p.author?.name ?? 'unknown'}\n${profileLine(p.profile)}\ntext: ${clean(p.content?.text)}\n</post>`
  ).join('\n\n'));

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,                  // must cover the thinking pass plus the verdict
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: stripLoneSurrogates(buildSystem(offer, feedback)),
               cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Score this post.\n\n${payload}` }]
  });

  const text = res.content.find(b => b.type === 'text')?.text ?? '{"verdicts":[]}';
  return { verdicts: JSON.parse(text).verdicts ?? [], usage: res.usage };
}
