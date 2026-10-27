// Sandbox merge gate: posts the `review-policy` status on a PR's head SHA.
// A change is "shared" when it touches shared/, scripts/ or .github/; otherwise "isolated".
// Success needs a review record (git note refs/notes/review/pr-<n> on the head) whose verdict
// matches the category, and for a shared change an APPROVED latest review by a non-author human
// on that exact head SHA. Anything else is failure.
import { execFileSync } from 'child_process';

const pr = process.env.PR;
const repo = process.env.GITHUB_REPOSITORY;
const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
};
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const p = await api('GET', `/repos/${repo}/pulls/${pr}`);
const head = p.head.sha;
const author = p.user.login;
const base = git('merge-base', `origin/${p.base.ref}`, head);
const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const shared = files.some((f) => /^(shared|scripts|\.github)\//.test(f));

let record = null;
try { record = JSON.parse(git('notes', `--ref=review/pr-${pr}`, 'show', head)); } catch {}

const reviews = await api('GET', `/repos/${repo}/pulls/${pr}/reviews?per_page=100`);
const latest = new Map();
for (const r of reviews.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at)))
  if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
const approvals = [...latest.values()].filter(
  (r) => r.state === 'APPROVED' && r.user.type === 'User' && r.user.login !== author && r.commit_id === head,
);

let state = 'failure';
let description;
if (!record || record.head !== head) description = `no review record for ${head.slice(0, 8)}`;
else if (!shared && record.verdict === 'PASSED') [state, description] = ['success', 'isolated change, review passed'];
else if (shared && record.verdict !== 'HUMAN') description = `shared change: record says ${record.verdict}, needs HUMAN`;
else if (shared && approvals.length === 0) description = `shared change: needs approval by someone other than ${author} on ${head.slice(0, 8)}`;
else if (shared) [state, description] = ['success', `shared change approved by ${approvals.map((a) => a.user.login).join(',')}`];
else description = `isolated change: record verdict ${record.verdict}`;

console.log(JSON.stringify({ pr, head, author, files, shared, record: record?.verdict ?? null, approvals: approvals.map((a) => a.user.login), state, description }));
await api('POST', `/repos/${repo}/statuses/${head}`, {
  state, context: 'review-policy', description,
  target_url: `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
});
