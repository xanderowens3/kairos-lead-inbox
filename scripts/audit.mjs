const KEY = process.env.TRIGIFY_API_KEY;
const g = async p => (await fetch('https://api.trigify.io/v1' + p, { headers: { 'x-api-key': KEY } })).json();
const l = await g('/searches');
for (const s of (l.data || [])) {
  const d = (await g('/searches/' + s.id)).data;
  const q = d.query || {}, f = d.filters || {};
  console.log(`■ ${d.name}   [${d.status}]   results: ${d.total_results}`);
  console.log(`   AND : ${JSON.stringify(q.keywords_and || [])}`);
  console.log(`   OR  : ${JSON.stringify(q.keywords || [])}`);
  console.log(`   NOT : ${JSON.stringify(q.keywords_not || [])}`);
  console.log(`   titles: ${JSON.stringify(f.job_titles || [])}  time: ${f.time_frame}  max: ${f.max_results}  sort: ${f.linkedin_sort_by}`);
  console.log('');
}
