/* ==========================================================================
   Trigify listening-search schema.
   Every enum below was read out of the live API's own validation errors,
   so this mirrors what the server will actually accept.
   ========================================================================== */

export const FREQUENCY  = ['hourly','every-12h','daily','weekly','monthly','quarterly'];
export const TIME_FRAME = ['past-24h','past-week','past-month','past-6-months','past-year','all-time'];
export const LI_SORT    = ['date_posted','relevance'];
export const LI_CONTENT = ['videos','photos','liveVideos','collaborativeArticles','documents'];

/* mode: what the query is built from
     keywords  → keywords / keywords_and / keywords_not
     profile   → a single profile_url
     publication → a named publication / channel / subreddit                     */
export const TYPES = {
  'linkedin-posts':      { platform:'LinkedIn',   label:'Posts',            mode:'keywords',    li:true },
  'linkedin-profile':    { platform:'LinkedIn',   label:'A profile',        mode:'profile' },
  'twitter-posts':       { platform:'X',          label:'Posts',            mode:'keywords' },
  'twitter-profile':     { platform:'X',          label:'A profile',        mode:'profile' },
  'reddit-posts':        { platform:'Reddit',     label:'Posts',            mode:'keywords' },
  'subreddit-posts':     { platform:'Reddit',     label:'A subreddit',      mode:'publication', pubLabel:'Subreddit', pubHint:'r/agency' },
  'youtube-videos':      { platform:'YouTube',    label:'Videos',           mode:'keywords' },
  'youtube-channel':     { platform:'YouTube',    label:'A channel',        mode:'profile',     urlHint:'https://youtube.com/@channel' },
  'substack-posts':      { platform:'Substack',   label:'Posts',            mode:'keywords' },
  'substack-notes':      { platform:'Substack',   label:'Notes',            mode:'keywords' },
  'substack-profile':    { platform:'Substack',   label:'A profile',        mode:'profile' },
  'podcast-keywords':    { platform:'Podcasts',   label:'By keyword',       mode:'keywords' },
  'podcast-episodes':    { platform:'Podcasts',   label:'A show',           mode:'publication', pubLabel:'Show', pubHint:'My First Million' },
  'hackernews-stories':  { platform:'Hacker News',label:'Stories',          mode:'keywords' },
  'dailydev-posts':      { platform:'daily.dev',  label:'Posts',            mode:'keywords' },
  'github-issues':       { platform:'GitHub',     label:'Issues',           mode:'keywords' },
  'github-discussions':  { platform:'GitHub',     label:'Discussions',      mode:'keywords' },
  'tiktok-videos':       { platform:'TikTok',     label:'Videos',           mode:'keywords' },
  'tiktok-profile':      { platform:'TikTok',     label:'A profile',        mode:'profile' },
  'bluesky-posts':       { platform:'Bluesky',    label:'Posts',            mode:'keywords' },
  'bluesky-profile':     { platform:'Bluesky',    label:'A profile',        mode:'profile' },
  'threads-posts':       { platform:'Threads',    label:'Posts',            mode:'keywords' },
  'threads-profile':     { platform:'Threads',    label:'A profile',        mode:'profile' },
  'threads-mentions':    { platform:'Threads',    label:'Mentions',         mode:'keywords' },
  'newsapi-ai-posts':    { platform:'News',       label:'Articles',         mode:'keywords' }
};

export const PLATFORMS = [...new Set(Object.values(TYPES).map(t => t.platform))];

export const ICONS = {
  'LinkedIn':'in', 'X':'X', 'Reddit':'r/', 'YouTube':'▶', 'Substack':'S',
  'Podcasts':'♪', 'Hacker News':'Y', 'daily.dev':'d', 'GitHub':'{ }',
  'TikTok':'♬', 'Bluesky':'⌂', 'Threads':'@', 'News':'N'
};

/* Build the exact POST body Trigify expects. Empty values are omitted so the
   preview shows only what is actually being sent. */
export function buildPayload(s){
  const t = TYPES[s.monitoring_type] || {};
  const query = { monitoring_type: s.monitoring_type };

  if (t.mode === 'keywords'){
    if (s.keywords.length)     query.keywords = s.keywords;
    if (s.keywords_and.length) query.keywords_and = s.keywords_and;
    if (s.keywords_not.length) query.keywords_not = s.keywords_not;
  }
  if (t.mode === 'profile'     && s.profile_url) query.profile_url = s.profile_url;
  if (t.mode === 'publication' && s.publication) query.publication = s.publication;

  const filters = {};
  if (s.frequency)                    filters.frequency = s.frequency;
  if (s.time_frame)                   filters.time_frame = s.time_frame;
  if (s.max_results)                  filters.max_results = Number(s.max_results);
  if (t.li && s.job_titles.length)    filters.job_titles = s.job_titles;
  if (t.li && s.content_type)         filters.content_type = s.content_type;
  if (t.li && s.linkedin_sort_by)     filters.linkedin_sort_by = s.linkedin_sort_by;
  if (t.li && s.mentions_member.length)       filters.mentions_member = s.mentions_member;
  if (t.li && s.mentions_organization.length) filters.mentions_organization = s.mentions_organization;

  const body = { name: s.name || 'Untitled search', query };
  if (Object.keys(filters).length) body.filters = filters;
  return body;
}

export const blank = () => ({
  name: '',
  monitoring_type: 'linkedin-posts',
  keywords: [], keywords_and: [], keywords_not: [],
  profile_url: '', publication: '',
  job_titles: [], mentions_member: [], mentions_organization: [],
  frequency: 'every-12h', time_frame: '', max_results: '',
  content_type: '', linkedin_sort_by: 'relevance'
});

/* ==========================================================================
   Trigify's own matching can't be trusted, so every result is re-checked here
   against the literal query before it is shown or qualified. Two things were
   verified directly against the live API:

     - AND matching breaks once a query needs 2+ keywords. One required term
       (even a multi-word phrase) is enforced; adding a second makes it behave
       like a relevance-weighted OR — only ~a third of results actually
       contained every term.
     - NOT matching is WHOLE-WORD: excluding "India" does NOT remove a post
       that says "Indian", because "Indian" is a different token.

   Matching here is WORD-BOUNDARY aware, for all three lists, so it agrees with
   Trigify's own NOT behaviour and avoids the trap where a short exclusion like
   "AI" would otherwise strike inside said / maintain / email and delete
   everything. A term matches only as a whole word or exact phrase:

       "India"        matches "India"          not "Indian"
       "AI"           matches "AI"             not "email" / "said"
       "job"          matches "job" / "job."   not "jobber"
       "looking for"  matches the phrase       not "looking forward"

   Trade-off: plurals and stems are distinct words, so "agency" does not match
   "agencies". Add both forms in the keyword field if you want the wider net.
   ========================================================================== */
function termRegex(term){
  const s = String(term).trim();
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startB = /\w/.test(s[0])            ? '\\b' : '';
  const endB   = /\w/.test(s[s.length - 1]) ? '\\b' : '';
  return new RegExp(startB + esc + endB, 'i');
}

export function matchesQuery(text, query){
  const t = text || '';
  const has = term => termRegex(term).test(t);
  const and = (query.keywords_and || []).filter(Boolean);
  const or  = (query.keywords     || []).filter(Boolean);
  const not = (query.keywords_not || []).filter(Boolean);
  if (and.length && !and.every(has)) return false;
  if (or.length  && !or.some(has))   return false;
  if (not.length &&  not.some(has))  return false;
  return true;
}

/* Split a result set into what genuinely matches the query vs what Trigify
   returned anyway. Only meaningful for keyword-mode searches. */
export function verifyResults(rows, query){
  if (!query || (!query.keywords_and?.length && !query.keywords?.length && !query.keywords_not?.length)){
    return { matched: rows, dropped: [] };
  }
  const matched = [], dropped = [];
  for (const r of rows) (matchesQuery(r.content?.text, query) ? matched : dropped).push(r);
  return { matched, dropped };
}
