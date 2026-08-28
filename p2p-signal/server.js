#!/usr/bin/env node
'use strict';

/*
 * Signalling service for p2p-files.html.
 *
 * It brokers exactly one thing: the WebRTC handshake. A sender posts its offer
 * and gets back a short code; a receiver trades that code for the offer and
 * posts an answer; the sender collects the answer and the session is destroyed.
 * Sessions live in memory only and expire after a few minutes.
 *
 * File contents never touch this process. They go browser to browser.
 *
 * No dependencies. Run it with: node server.js
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = numberFromEnv('PORT', 8787);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PATH = normaliseBasePath(process.env.BASE_PATH || '/p2p-signal');
const SESSION_TTL_MS = numberFromEnv('SESSION_TTL_MS', 5 * 60 * 1000);
const POLL_TIMEOUT_MS = numberFromEnv('POLL_TIMEOUT_MS', 25 * 1000);
const MAX_SESSIONS = numberFromEnv('MAX_SESSIONS', 1000);
const MAX_BODY_BYTES = numberFromEnv('MAX_BODY_BYTES', 64 * 1024);
const CREATE_LIMIT = numberFromEnv('CREATE_LIMIT', 30);
const CREATE_WINDOW_MS = numberFromEnv('CREATE_WINDOW_MS', 10 * 60 * 1000);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SERVE_DIR = process.env.SERVE_DIR ? path.resolve(process.env.SERVE_DIR) : null;

// Alphabet without characters that get misread out loud or on screen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** code -> { offer, answer, claimed, expiresAt, token, waiters:Set } */
const sessions = new Map();
/** ip -> { count, resetAt } */
const createRate = new Map();

const server = http.createServer(handleRequest);

function handleRequest(req, res) {
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        return sendJson(res, 400, { error: 'bad_request' });
    }

    const route = routeFor(url.pathname);
    if (route === null) return serveStatic(req, res, url.pathname);

    if (req.method === 'GET' && route === '/health') {
        return sendJson(res, 200, { ok: true, sessions: sessions.size });
    }
    if (req.method === 'POST' && route === '/sessions') {
        return createSession(req, res);
    }

    const offerMatch = /^\/sessions\/([A-Za-z0-9]{1,16})$/.exec(route);
    if (offerMatch && req.method === 'GET') {
        return claimOffer(res, offerMatch[1]);
    }

    const answerMatch = /^\/sessions\/([A-Za-z0-9]{1,16})\/answer$/.exec(route);
    if (answerMatch && req.method === 'POST') {
        return submitAnswer(req, res, answerMatch[1]);
    }
    if (answerMatch && req.method === 'GET') {
        return awaitAnswer(req, res, answerMatch[1], url.searchParams.get('token') || '');
    }

    sendJson(res, 404, { error: 'not_found' });
}

function createSession(req, res) {
    const ip = clientIp(req);
    if (!allowCreate(ip)) return sendJson(res, 429, { error: 'rate_limited' });

    sweep();
    if (sessions.size >= MAX_SESSIONS) return sendJson(res, 503, { error: 'busy' });

    readJsonBody(req, res, body => {
        const offer = typeof body.offer === 'string' ? body.offer : '';
        if (!offer) return sendJson(res, 400, { error: 'missing_offer' });

        const code = uniqueCode();
        const token = crypto.randomBytes(16).toString('hex');
        sessions.set(code, {
            offer,
            answer: null,
            claimed: false,
            token,
            expiresAt: Date.now() + SESSION_TTL_MS,
            waiters: new Set()
        });
        sendJson(res, 201, { code, token, expiresInMs: SESSION_TTL_MS });
    });
}

function claimOffer(res, rawCode) {
    const session = liveSession(rawCode);
    if (!session) return sendJson(res, 404, { error: 'unknown_code' });
    if (session.claimed) return sendJson(res, 409, { error: 'already_claimed' });

    session.claimed = true;
    sendJson(res, 200, { offer: session.offer });
}

function submitAnswer(req, res, rawCode) {
    const session = liveSession(rawCode);
    if (!session) return sendJson(res, 404, { error: 'unknown_code' });
    if (!session.claimed) return sendJson(res, 409, { error: 'not_claimed' });
    if (session.answer) return sendJson(res, 409, { error: 'already_answered' });

    readJsonBody(req, res, body => {
        const answer = typeof body.answer === 'string' ? body.answer : '';
        if (!answer) return sendJson(res, 400, { error: 'missing_answer' });

        session.answer = answer;
        for (const waiter of session.waiters) waiter(session);
        session.waiters.clear();
        sendJson(res, 200, { ok: true });
    });
}

function awaitAnswer(req, res, rawCode, token) {
    const code = normaliseCode(rawCode);
    const session = liveSession(code);
    if (!session) return sendJson(res, 404, { error: 'unknown_code' });
    if (!tokensMatch(session.token, token)) return sendJson(res, 403, { error: 'bad_token' });

    if (session.answer) return deliverAnswer(res, code, session);

    // Hold the request open so the sender learns about the answer the moment it
    // lands. A 204 just means "ask again", not "gone".
    const finish = settled => {
        clearTimeout(timer);
        session.waiters.delete(finish);
        req.off('close', onClose);
        if (!settled) return sendStatus(res, 204);
        if (!sessions.has(code)) return sendJson(res, 404, { error: 'expired' });
        deliverAnswer(res, code, settled);
    };
    const onClose = () => {
        clearTimeout(timer);
        session.waiters.delete(finish);
    };
    const timer = setTimeout(() => finish(null), POLL_TIMEOUT_MS);

    session.waiters.add(finish);
    req.on('close', onClose);
}

function deliverAnswer(res, code, session) {
    sessions.delete(code);
    sendJson(res, 200, { answer: session.answer });
}

// --- session helpers -------------------------------------------------------

function normaliseCode(raw) {
    return String(raw || '').toUpperCase();
}

function liveSession(rawCode) {
    const code = normaliseCode(rawCode);
    const session = sessions.get(code);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        expire(code, session);
        return null;
    }
    return session;
}

function uniqueCode() {
    for (;;) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }
        if (!sessions.has(code)) return code;
    }
}

function tokensMatch(expected, given) {
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(given));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function expire(code, session) {
    sessions.delete(code);
    for (const waiter of session.waiters) waiter(null);
    session.waiters.clear();
}

function sweep() {
    const now = Date.now();
    for (const [code, session] of sessions) {
        if (session.expiresAt <= now) expire(code, session);
    }
    for (const [ip, entry] of createRate) {
        if (entry.resetAt <= now) createRate.delete(ip);
    }
}

function allowCreate(ip) {
    const now = Date.now();
    const entry = createRate.get(ip);
    if (!entry || entry.resetAt <= now) {
        createRate.set(ip, { count: 1, resetAt: now + CREATE_WINDOW_MS });
        return true;
    }
    entry.count += 1;
    return entry.count <= CREATE_LIMIT;
}

function clientIp(req) {
    if (TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.length) {
            return forwarded.split(',')[0].trim();
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

// --- request and response plumbing -----------------------------------------

function routeFor(pathname) {
    if (!pathname.startsWith(BASE_PATH)) return null;
    const rest = pathname.slice(BASE_PATH.length);
    if (rest === '') return '/';
    if (!rest.startsWith('/')) return null;
    return rest.replace(/\/+$/, '') || '/';
}

function normaliseBasePath(value) {
    let base = value.trim();
    if (!base.startsWith('/')) base = '/' + base;
    return base.replace(/\/+$/, '');
}

function numberFromEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readJsonBody(req, res, onBody) {
    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', chunk => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            aborted = true;
            sendJson(res, 413, { error: 'too_large' });
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (aborted) return;
        try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
            onBody(parsed);
        } catch {
            sendJson(res, 400, { error: 'bad_json' });
        }
    });
}

function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store'
    });
    res.end(body);
}

function sendStatus(res, status) {
    res.writeHead(status, { 'cache-control': 'no-store' });
    res.end();
}

// --- optional static serving ------------------------------------------------
// Handy for running the whole tool from one process while testing. In
// production you will more likely let your existing web server hold the files.

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
    if (!SERVE_DIR || req.method !== 'GET') return sendJson(res, 404, { error: 'not_found' });

    const decoded = decodeURIComponent(pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const target = path.resolve(SERVE_DIR, relative);
    if (target !== SERVE_DIR && !target.startsWith(SERVE_DIR + path.sep)) {
        return sendJson(res, 403, { error: 'forbidden' });
    }

    fs.stat(target, (err, stat) => {
        if (err || !stat.isFile()) return sendJson(res, 404, { error: 'not_found' });
        res.writeHead(200, {
            'content-type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
            'content-length': stat.size,
            'cache-control': 'no-cache'
        });
        fs.createReadStream(target).pipe(res);
    });
}

// --- lifecycle --------------------------------------------------------------

const sweepTimer = setInterval(sweep, 30 * 1000);
sweepTimer.unref();

function shutdown() {
    clearInterval(sweepTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
    server.listen(PORT, HOST, () => {
        console.log(`p2p signalling on http://${HOST}:${PORT}${BASE_PATH}`);
        if (SERVE_DIR) console.log(`serving files from ${SERVE_DIR}`);
    });
}

module.exports = { server };
