'use strict';
/**
 * Sets the admin password for the NV store backend.
 *
 *   node server/set-password.js                       # prompts, input hidden
 *   NV_ADMIN_PASSWORD='...' node server/set-password.js   # non-interactive
 *   node server/set-password.js --print               # print NV_ADMIN_HASH, write nothing
 *
 * The password itself is never stored. What lands in server/data/admin.json
 * is a random salt plus an scrypt hash, which is not reversible.
 *
 * --print is for hosted deployments: admin.json is gitignored and a platform
 * with an ephemeral filesystem has nowhere to keep it, so the same salt and
 * hash go into the NV_ADMIN_HASH environment variable instead.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = process.env.NV_DATA_DIR || path.join(__dirname, 'data');
const ADMIN = path.join(DATA_DIR, 'admin.json');
const MIN_LENGTH = 10;
const PRINT_ONLY = process.argv.slice(2).some(function (a) {
  return a === '--print' || a === '--env';
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    updated: new Date().toISOString()
  };
}

/**
 * One prompter, shared across both questions. readline.createInterface is
 * meant to be asked repeatedly — a fresh interface per question was the
 * original bug here: on anything other than a live TTY, the first interface
 * drains all of stdin answering the first question, and a second interface
 * created after it finds nothing left to read. It then waits forever on
 * input that already arrived, or — once stdin has actually ended, as it does
 * for piped input — the process just exits with nothing printed and nothing
 * saved, silently and with exit code 0. Reusing one interface for both
 * questions is what readline is actually built for, and fixes both cases.
 */
function createPrompter() {
  const isTTY = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY
  });

  // On a real terminal, hiding means suppressing readline's own echo so the
  // password never reaches the screen or the scrollback. Off a real
  // terminal there is no echo to suppress, so hidden questions behave like
  // ordinary ones — but the question text is always printed either way. It
  // used to be dropped whenever isTTY was false, which is what made the
  // failure above silent instead of merely confusing.
  const write = rl._writeToOutput.bind(rl);
  let muted = false;
  rl._writeToOutput = function (s) { if (!muted) write(s); };

  // Off a real terminal, readline's own .question() is not safe to call
  // twice in a row: piped or redirected input typically arrives as one
  // chunk holding both answers, and readline emits a 'line' event for each
  // as soon as it finds them — including the second one, before our code
  // has awaited its way back to asking for it. .question() subscribes with
  // a one-shot listener, so a line with nothing listening for it yet is
  // simply gone, not queued, and the second question then waits forever on
  // input that already arrived and was discarded. A real person typing can
  // never trigger this — a keystroke cannot arrive faster than the event
  // loop — so the interactive path below is untouched; only the
  // non-interactive path needs its own queue that outlives any individual
  // ask() call.
  const queued = [];
  const waiting = [];
  if (!isTTY) {
    rl.on('line', function (line) {
      if (waiting.length) waiting.shift()(line);
      else queued.push(line);
    });
  }

  function ask(question, hide) {
    if (hide && isTTY) {
      return new Promise(function (resolve) {
        process.stdout.write(question);
        muted = true;
        rl.question('', function (answer) {
          muted = false;
          process.stdout.write('\n');
          resolve(answer);
        });
      });
    }
    if (isTTY) {
      return new Promise(function (resolve) { rl.question(question, resolve); });
    }
    process.stdout.write(question);
    return new Promise(function (resolve) {
      if (queued.length) resolve(queued.shift());
      else waiting.push(resolve);
    });
  }

  return { ask: ask, close: function () { rl.close(); } };
}

function save(password) {
  const record = hashPassword(password);

  // --print never touches the disk. On a deployment the credential belongs in
  // the platform's environment settings, and writing a file the filesystem is
  // going to discard would only suggest otherwise.
  if (PRINT_ONLY) {
    console.log('\n  Set this as NV_ADMIN_HASH in your host\'s environment settings:\n');
    console.log('  ' + record.salt + ':' + record.hash + '\n');
    console.log('  It is a salt and an scrypt hash, not the password, and it is');
    console.log('  not reversible. Nothing was written to disk.\n');
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN, JSON.stringify(record, null, 2));
  try { fs.chmodSync(ADMIN, 0o600); } catch (err) { /* best effort on Windows */ }
  console.log('\n  Admin password set. Start the server with:  node server/server.js');
  console.log('  Deploying? Re-run with --print to get the NV_ADMIN_HASH form.\n');
}

// process.exitCode + a natural return, not process.exit(). On Windows, when
// stdout is piped or redirected to a file rather than a real console,
// console.log writes can be asynchronous — calling process.exit() right
// after one truncates it. This is exactly how --print used to lose its own
// output when run non-interactively: the prompts appeared, the hash line
// did not. Setting process.exitCode and letting the event loop drain on its
// own flushes everything first and still exits with the right code.
(async function main() {
  const fromEnv = process.env.NV_ADMIN_PASSWORD;
  if (fromEnv) {
    if (fromEnv.trim().length < MIN_LENGTH) {
      console.error('\n  NV_ADMIN_PASSWORD is too short - use at least ' + MIN_LENGTH + ' characters.\n');
      process.exitCode = 1;
      return;
    }
    save(fromEnv.trim());
    return;
  }

  const prompter = createPrompter();
  const pw = (await prompter.ask('New admin password: ', true)).trim();
  if (pw.length < MIN_LENGTH) {
    prompter.close();
    console.error('\n  Too short - use at least ' + MIN_LENGTH + ' characters.\n');
    process.exitCode = 1;
    return;
  }
  const again = (await prompter.ask('Confirm password:   ', true)).trim();
  prompter.close();
  if (pw !== again) {
    console.error('\n  Passwords did not match. Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }
  save(pw);
})().catch(function (err) {
  // A safety net for exactly the failure mode this file used to have: an
  // error with nowhere to go is indistinguishable from nothing happening.
  console.error('\n  ' + (err && err.message ? err.message : err) + '\n');
  process.exitCode = 1;
});
