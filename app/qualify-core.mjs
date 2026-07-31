/* ==========================================================================
   Qualification core — the prompt + schema + Claude call that scores a post
   against an offer. Shared by the server's /analyze endpoint and the CLI
   script so they can never drift.

   Scoring: 0–100, driven by the offer context. Disqualifiers are a hard reject;
   ICP qualifiers push the score up. No numeric threshold — the model makes a
   binary `recommend` call (worth pursuing or not) and the score ranks the
   recommended ones. Feedback examples the user has rated are injected as
   few-shot guidance so the agent aligns to their actual judgment over time.
   ========================================================================== */

export const MODEL = 'claude-sonnet-5';    // stronger judgment; thinking disabled to control cost
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
    ? items.map(x => `- [importance ${x.weight ?? 5}/10] ${x.text}`).join('\n')
    : '- (none given)';
};

/* The scored examples define the scale: a real post at each band, and why it
   sits there. Rendered high to low so the top of the range is read first. */
const SCORE_BANDS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
function examples(ex){
  if (!ex) return '';
  const rows = SCORE_BANDS
    .filter(b => (ex[b]?.post || '').trim())
    .map(b => `[SCORES ${b}]\nPOST: ${clean(ex[b].post)}` +
              (ex[b].why?.trim() ? `\nWHY IT SCORES ${b}: ${clean(ex[b].why)}` : ''));
  return rows.length ? `\n\nWORKED EXAMPLES — real posts and the score each was given\n${rows.join('\n\n')}\n` : '';
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
   marked cacheable by the caller (≈0.1× price on cache reads). */
/* The server reads offers straight from storage, so old-shaped ones (plain-string
   qualifiers, the two loose example fields) must render correctly here too. */
export function buildSystem(offer, feedback = []){
  if (offer && !offer.scoreExamples && (offer.goodExample || offer.badExample)){
    offer = { ...offer, scoreExamples: {
      80: { post: offer.goodExample || '', why: '' },
      30: { post: offer.badExample  || '', why: '' }
    } };
  }
  const fb = feedback.filter(f => f.text && (f.rating || f.userScore != null || f.golden));
  const fbBlock = fb.length ? `

HOW THIS USER HAS RATED PAST LEADS
Learn from these — they are the user's own verdicts and matter more than the
general rules above. Where a user score is given, calibrate to it: a post like
one the user called a 75 should score near 75, and similar profiles nearby. Pay
closest attention to DISAGREEMENTS (where the user's number differs from yours,
or they promoted a post you scored low) — move toward the user on posts like
those. The author's profile is shown; weigh it the same way you do when scoring.
${fb.map(f => {
  const tag = [
    f.golden ? 'PINNED' : null,
    f.rating === 'good' ? 'GOOD LEAD' : f.rating === 'bad' ? 'NOT A FIT' : null,
    f.userScore != null ? `user would score it ${f.userScore}` : null,
    (f.userScore != null && f.agentScore != null && Math.abs(f.userScore - f.agentScore) >= 15)
      ? `you scored it ${f.agentScore}` : null,
    f.promoted ? 'user pulled this into the inbox' : null,
    f.note || null
  ].filter(Boolean).join(' — ');
  return `\n[${tag}]\n${fbProfile(f.profile)}${clean(f.text)}`;
}).join('\n')}` : '';

  return `You screen social-media posts to find people worth approaching about a specific offer.

THE OFFER
${offer.sell || '(not described)'}

WHO IT IS FOR
${offer.icpText || '(not described)'}

You give each post a single score from 0 to 100 for how worth-approaching the author is.
Treat it as a weighted judgment, NOT a checklist. Start from how well the post fits the
offer — does this person plausibly have a reason to want what is being sold? Then let the
factors below push the score up or down. No single factor decides the outcome; they tip
the scale.

SIGNS OF A PROBLEM THE OFFER SOLVES (raise the score when present)
${list(offer.pains)}

QUALIFIERS — each nudges the score UP. The importance says how much it matters:
10 is the strongest thing to look for, 1 is close to irrelevant.
${weighted(offer.qualifiers)}

DISQUALIFIERS — each nudges the score DOWN, weighted the same way. These are
penalties, not vetoes: a post can still be a good lead despite one of them if the
other signals are strong.
${weighted(offer.disqualifiers)}
${examples(offer.scoreExamples)}
HOW TO JUDGE
Weigh everything into one 0–100 score. A company that fits who this is for and shows a
reason to want outbound help scores high; each qualifier it meets lifts it further; each
disqualifier lowers it but never eliminates it on its own. Someone hiring an SDR or BDR is
an adjacent buyer — they want outbound and are weighing doing it in-house — so if that is
listed as a qualifier, treat it as a real positive, not noise.

Only score very low (and do not recommend) the posts that clearly aren't a person with a
business reason to care: job-board listings, students, certification announcements, pure
self-promotion of an unrelated product, news commentary, or a direct competitor selling
the identical service. Everything with a plausible business behind it gets placed on the
spectrum rather than thrown out.

For most posts you also get the author's LinkedIn PROFILE — job title, company, industry,
follower count, location, and a summary. Use it. This is often where the qualifiers and
disqualifiers actually show up: whether they clear a follower threshold, what country they
are in, whether their company is in marketing / AI / automation, whether they are a
decision-maker. A weak-looking post from a strong profile can still be a strong lead, and
vice versa — weigh both. When no profile is given, judge on the post alone, lean on
icp_fit "unknown", and do not invent details you were not shown.

score: 0–100, the weighted judgment above. Rank by it.
recommend: true if, on balance, this is plausibly worth the user putting eyes on.
evidence: the exact phrase showing the fit or the problem, or null.
reason: one or two plain sentences on the balance of factors — what lifted it and what
pulled it down.${fbBlock}`;
}

export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'recommend', 'score', 'icp_fit', 'evidence', 'reason'],
    properties: {
      id: { type: 'string' },
      recommend: { type: 'boolean' },
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

/* Judge one batch of posts. `client` is an Anthropic SDK instance.
   Each post may carry an enriched `.profile` object (see server /profile/enrich). */
export async function judgeBatch(client, offer, posts, feedback = []){
  // sanitize the assembled strings too — author names and profile fields carry
  // emoji as well and never pass through clean()
  const payload = stripLoneSurrogates(posts.map(p =>
    `<post id="${p.id}">\nauthor: ${p.author?.name ?? 'unknown'}\n${profileLine(p.profile)}\ntext: ${clean(p.content?.text)}\n</post>`
  ).join('\n\n'));

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'disabled' },   // scoring is single-step; keep output tokens (and cost) down
    system: [{ type: 'text', text: stripLoneSurrogates(buildSystem(offer, feedback)),
               cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Judge each post. One verdict per post id.\n\n${payload}` }]
  });

  const text = res.content.find(b => b.type === 'text')?.text ?? '{"verdicts":[]}';
  return { verdicts: JSON.parse(text).verdicts ?? [], usage: res.usage };
}
