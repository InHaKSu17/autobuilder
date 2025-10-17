/*
Auto-Builder Server (Render-ready, ESM)
*/

import express from 'express';
import bodyParser from 'body-parser';
import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import axios from 'axios';
import fs from 'fs-extra';
import tmp from 'tmp';
import Datauri from 'datauri';
import OpenAI from 'openai';
import path from 'path';

const app = express();
app.use(bodyParser.json({ limit: '20mb' }));

// Config
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_SECRET = process.env.DEFAULT_SECRET || 'demo-secret';
const GIT_USER_NAME = process.env.GIT_USER_NAME || 'Auto Builder';
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || 'autobuilder@example.com';
const SERVER_PORT = process.env.PORT || 3000;

if (!GITHUB_TOKEN) console.warn('Warning: GITHUB_TOKEN not set. Repo creation will fail.');
if (!OPENAI_API_KEY) console.warn('Warning: OPENAI_API_KEY not set. LLM generation will be mocked.');

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Datauri parser instance
const parser = new Datauri();

// In-memory student secret store
const studentSecrets = new Map();
studentSecrets.set('student@example.com', DEFAULT_SECRET);

function verifySecret(email, secret) {
  const expected = studentSecrets.get(email) || DEFAULT_SECRET;
  return secret === expected;
}

async function writeAttachments(attachments = [], targetDir) {
  await fs.ensureDir(targetDir);
  const written = [];
  for (const att of attachments) {
    const { name, url } = att;
    if (!name || !url) continue;
    const parsed = parser.parse(url);
    const filePath = path.join(targetDir, name);
    await fs.writeFile(filePath, parsed.content);
    written.push(filePath);
  }
  return written;
}

async function generateFilesWithLLM(brief, attachments) {
  if (!openai) {
    // Mock response if no API key
    const files = [
      { path: 'index.html', content: `<!doctype html><html><head><meta charset="utf-8"><title>Auto App</title></head><body><h1>Auto-generated app</h1><p>${brief}</p><div id="output"></div><script>document.getElementById('output').textContent = 'Generated at ' + new Date().toISOString();</script></body></html>` }
    ];
    const readme = `# Auto-generated app\n\nBrief: ${brief}`;
    return { files, readme };
  }

  const prompt = `You are an assistant that returns a minimal static web app for the following brief. Reply ONLY with a JSON object: { files: [{ path, content }], readme } where content contains the exact file contents. Brief:\n\n${brief}\n\nAttachments: ${JSON.stringify(attachments || [])}`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1500
  });

  const text = resp.choices[0].message.content;
  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      files: [{ path: 'index.html', content: `<!doctype html><html><body><h1>Generated app</h1><p>Failed to parse LLM output. See server logs.</p></body></html>` }],
      readme: '# Auto app\n\n(LLM output parse failed)'
    };
  }
}

function shortName(task) {
  return (task || 'task').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
}

async function createGithubRepoAndPush(owner, repoName, files, readme) {
  const { data: repo } = await octokit.repos.createForAuthenticatedUser({
    name: repoName,
    private: false,
    description: 'Auto-generated repo from autobuilder',
    license_template: 'mit'
  });

  const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
  await fs.ensureDir(tmpDir);
  for (const f of files) {
    const filePath = path.join(tmpDir, f.path);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, f.content, 'utf8');
  }

  await fs.writeFile(path.join(tmpDir, 'README.md'), readme || '# Auto-generated');
  await fs.writeFile(path.join(tmpDir, 'LICENSE'), 'MIT');

  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', GIT_USER_NAME);
  await git.addConfig('user.email', GIT_USER_EMAIL);
  await git.add('./*');
  await git.commit('Initial auto-generated commit');
  await git.addRemote('origin', repo.clone_url);
  await git.push(['-u', 'origin', 'main']);

  const commitSha = (await octokit.repos.getCommit({ owner: repo.owner.login, repo: repo.name, ref: 'heads/main' })).data.sha;
  return { repo_url: repo.html_url, commit_sha: commitSha };
}

async function notifyEvaluationUrl(evaluation_url, body, maxRetries = 5) {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await axios.post(evaluation_url, body, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      if (resp.status >= 200 && resp.status < 300) return resp.data;
    } catch {}
    await new Promise(r => setTimeout(r, delay));
    delay *= 2;
  }
  throw new Error('Failed to notify evaluation_url after retries');
}

app.post('/api-endpoint', async (req, res) => {
  const payload = req.body;
  const { email, secret, task, round, nonce, brief, checks, evaluation_url, attachments } = payload || {};
  if (!email || !task || !round || !nonce || !evaluation_url) return res.status(400).json({ error: 'missing required fields' });

  if (!verifySecret(email, secret)) return res.status(401).json({ error: 'invalid secret' });

  res.status(200).json({ status: 'accepted' });

  try {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
    await writeAttachments(attachments || [], tmpDir);
    const generated = await generateFilesWithLLM(brief || 'Auto app', attachments || []);
    const files = generated.files || [];
    const readme = generated.readme || ('# Auto-generated app\n\n' + (brief || ''));

    const repoName = `${shortName(task)}-${Date.now().toString(36).slice(-6)}`;
    const result = await createGithubRepoAndPush(null, repoName, files, readme);

    const notifyBody = {
      email,
      task,
      round,
      nonce,
      repo_url: result.repo_url,
      commit_sha: result.commit_sha,
      deploy_url: null
    };
    await notifyEvaluationUrl(evaluation_url, notifyBody);
    console.log('Notified evaluation_url for', task);
  } catch (err) {
    console.error('Processing failed:', err);
  }
});

app.listen(SERVER_PORT, () => console.log(`Auto-builder server listening on ${SERVER_PORT}`));
