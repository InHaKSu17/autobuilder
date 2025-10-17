/*
README & Single-file implementation for: Auto-Builder API (Render deployment removed)

This file is a prototype Express server that implements the "student" side of the assignment you posted.

Key behavior:
- Accepts POST /api-endpoint with the JSON task request.
- Verifies the provided secret against an in-memory store (replace with DB in production).
- Uses an LLM (OpenAI) to generate minimal app files from the brief and attachments. The LLM is asked to return a JSON structure { files: [{path, content}], readme }.
- Creates a public GitHub repo using Octokit, pushes files, adds MIT LICENSE and README.md.
- DOES NOT create or call any Render API. You will deploy the generated repo to Render yourself (instructions below).
- Posts back to evaluation_url with repo_url and commit_sha and a placeholder deploy_url (null) within 10 minutes.

ENVIRONMENT VARIABLES (set these in your environment or Render secret store):
  GITHUB_TOKEN - a personal access token with repo scope (required)
  OPENAI_API_KEY - OpenAI API key (optional; if not set the generation step will be mocked)
  DEFAULT_SECRET - fallback secret used to validate incoming requests (for demo)
  GIT_USER_NAME, GIT_USER_EMAIL - identity used to commit

Notes on deployment to Render (manual by you):
- After the server creates the GitHub repo, log into Render and create a new Static Site (or Web Service) pointing to the new repo and branch (usually main).
- Configure any build commands or root directories if needed.
- Once Render finishes the first deploy, copy the Render URL (e.g. https://project-name.onrender.com) and either:
  - POST it to the evaluation_url in a follow-up webhook you send manually, or
  - We can add an optional endpoint in this server to accept a Render webhook and then automatically notify evaluation_url — tell me if you want that.

Dependencies (package.json):
  "dependencies": {
    "express": "^4.x",
    "body-parser": "^1.x",
    "@octokit/rest": "^19.x",
    "simple-git": "^3.x",
    "openai": "^4.x",
    "axios": "^1.x",
    "tmp": "^0.2.x",
    "datauri/parser": "^2.x",
    "fs-extra": "^10.x",
  }

Run locally:
  export GITHUB_TOKEN=... OPENAI_API_KEY=... DEFAULT_SECRET=mysupersecret
  node autobuilder-no-render.js

API: POST /api-endpoint
  Body: the JSON request described in your spec. { email, secret, task, round, nonce, brief, checks, evaluation_url, attachments }

Behavior summary:
  1. Validates secret. If invalid -> 401.
  2. Returns HTTP 200 immediately with { status: "accepted" } and proceeds to processing.
  3. Generates app files using LLM (or a mock if no API key).
  4. Creates a GitHub repo named uniquely based on task (task-{shortsha}).
  5. Pushes files, creates a commit, adds MIT LICENSE and README.
  6. Posts back to evaluation_url within 10 minutes with: { email, task, round, nonce, repo_url, commit_sha, deploy_url: null }

Security notes:
- The server intentionally avoids pushing any secrets into git history.
- In production, use a persistent DB, rotate tokens, validate attachments, and scan generated repo for secrets.


*/


import express from 'express';
import bodyParser from 'body-parser';
import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import axios from 'axios';
import fs from 'fs-extra';
import tmp from 'tmp';
import Datauri from 'datauri';
const { Parser: DataURIParser } = Datauri;


import OpenAI from 'openai';

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
const parser = new DataURIParser();

// In-memory student secret store (replace with DB). Keyed by email.
const studentSecrets = new Map();
studentSecrets.set('student@example.com', DEFAULT_SECRET);

function verifySecret(email, secret) {
  const expected = studentSecrets.get(email) || DEFAULT_SECRET;
  return secret === expected;
}

async function writeAttachments(attachments = [], targetDir) {
  await fs.ensureDir(targetDir);
  const written = [];
  for (const att of attachments || []) {
    const { name, url } = att;
    if (!name || !url) continue;
    const parsed = parser.parse(url);
    const filePath = `${targetDir}/${name}`;
    await fs.writeFile(filePath, parsed.content);
    written.push(filePath);
  }
  return written;
}

async function generateFilesWithLLM(brief, attachments) {
  // If OpenAI key provided, ask the model to return JSON: { files: [{path, content}], readme }
  if (!openai) {
    // Mock minimal app: index.html and script that shows the brief
    const files = [
      { path: 'index.html', content: `<!doctype html>\n<html><head><meta charset="utf-8"><title>Auto App</title></head><body><h1>Auto-generated app</h1><p>${brief}</p><div id="output"></div><script>document.getElementById('output').textContent = 'Generated at ' + new Date().toISOString();</script></body></html>` },
    ];
    const readme = `# Auto-generated app\n\nBrief: ${brief}`;
    return { files, readme };
  }

  const prompt = `You are an assistant that returns a minimal static web app for the following brief. Reply ONLY with a JSON object: { files: [{ path, content }], readme } where content contains the exact file contents. Brief:\n\n${brief}\n\nAttachments: ${JSON.stringify(attachments || [])}`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1500,
  });

  const text = resp.choices[0].message.content;
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) {
    // fallback to mock
    return {
      files: [ { path: 'index.html', content: `<!doctype html><html><body><h1>Generated app</h1><p>Failed to parse LLM output. See server logs.</p></body></html>` } ],
      readme: `# Auto app\n\n(LLM output parse failed)`
    };
  }
}

function shortName(task) {
  return (task || 'task').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
}

async function createGithubRepoAndPush(owner, repoName, files, readme) {
  // Create repo
  const { data: repo } = await octokit.repos.createForAuthenticatedUser({
    name: repoName,
    private: false,
    description: 'Auto-generated repo from autobuilder',
    license_template: 'mit'
  });

  // Use simple-git to push files
  const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
  await fs.ensureDir(tmpDir);
  for (const f of files) {
    const filePath = `${tmpDir}/${f.path}`;
    await fs.ensureDir(require('path').dirname(filePath));
    await fs.writeFile(filePath, f.content, 'utf8');
  }
  await fs.writeFile(`${tmpDir}/README.md`, readme || '# Auto-generated');
  await fs.writeFile(`${tmpDir}/LICENSE`, 'MIT');

  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', GIT_USER_NAME);
  await git.addConfig('user.email', GIT_USER_EMAIL);
  await git.add('./*');
  await git.commit('Initial auto-generated commit');
  await git.addRemote('origin', repo.clone_url);
  await git.push(['-u', 'origin', 'main']);

  // Get latest commit sha
  const commitSha = (await octokit.repos.getCommit({ owner: repo.owner.login, repo: repo.name, ref: 'heads/main' })).data.sha;

  return { repo_url: repo.html_url, commit_sha: commitSha };
}

async function notifyEvaluationUrl(evaluation_url, body, maxRetries = 5) {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await axios.post(evaluation_url, body, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      if (resp.status >= 200 && resp.status < 300) return resp.data;
    } catch (e) {
      // continue to retry
    }
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

  // immediate 200
  res.status(200).json({ status: 'accepted' });

  try {
    const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
    await writeAttachments(attachments || [], tmpDir);

    const generated = await generateFilesWithLLM(brief || 'Auto app', attachments || []);
    const files = generated.files || [];
    const readme = generated.readme || ('# Auto-generated app\n\n' + (brief || ''));

    const repoName = `${shortName(task)}-${Date.now().toString(36).slice(-6)}`;
    const result = await createGithubRepoAndPush(null, repoName, files, readme);

    // We do NOT create any Render services here. deploy_url is left null for you to deploy manually.
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
