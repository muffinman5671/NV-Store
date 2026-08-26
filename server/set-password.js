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
 * Ask for a line. When hiding on a real terminal we suppress readline's own
 * echo, so the password never reaches the screen or the scrollback. When stdin
 * is a pipe there is nothing to echo and nothing to hide.
 */
function ask(question, hide) {
  return new Promise(function (resolve) {
    const isTTY = Boolean(process.stdin.isTTY);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: isTTY
    });

    if (hide && isTTY) {
      const write = rl._writeToOutput.bind(rl);
      let muted = false;
      rl._writeToOutput = function (s) { if (!muted) write(s); };
      process.stdout.write(question);
      muted = true;
      rl.question('', function (answer) {
        muted = false;
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
      return;
    }

    rl.question(isTTY ? question : '', function (answer) {
      rl.close();
      resolve(answer);
    });
  });
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

(async function main() {
  const fromEnv = process.env.NV_ADMIN_PASSWORD;
  if (fromEnv) {
    if (fromEnv.trim().length < MIN_LENGTH) {
      console.error('\n  NV_ADMIN_PASSWORD is too short - use at least ' + MIN_LENGTH + ' characters.\n');
      process.exit(1);
    }
    save(fromEnv.trim());
    process.exit(0);
  }

  const pw = (await ask('New admin password: ', true)).trim();
  if (pw.length < MIN_LENGTH) {
    console.error('\n  Too short - use at least ' + MIN_LENGTH + ' characters.\n');
    process.exit(1);
  }
  const again = (await ask('Confirm password:   ', true)).trim();
  if (pw !== again) {
    console.error('\n  Passwords did not match. Nothing was changed.\n');
    process.exit(1);
  }
  save(pw);
  process.exit(0);
})();
