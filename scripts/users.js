#!/usr/bin/env node
/**
 * Manage dialer accounts. Needs DATABASE_URL (set automatically in Render's
 * Shell; set it yourself if running from your own computer).
 *
 *   node scripts/users.js add <username> [--number +15551234567] [--email a@b.com] [--admin]
 *   node scripts/users.js reset-password <username>
 *   node scripts/users.js set <username> [--number ...] [--email ...] [--admin | --not-admin]
 *   node scripts/users.js list
 *   node scripts/users.js remove <username>
 *
 * Passwords are generated randomly and printed ONCE. Only a hash is stored,
 * so if one is lost, run reset-password to get a new one.
 */
require('dotenv').config();
const db = require('../db');

function parseArgs(argv) {
  const [command, username, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--admin') opts.isAdmin = true;
    else if (a === '--not-admin') opts.isAdmin = false;
    else if (a === '--number') opts.callerId = rest[++i];
    else if (a === '--email') opts.email = rest[++i];
    else throw new Error(`unknown option: ${a}`);
  }
  return { command, username, opts };
}

function checkNumber(n) {
  if (n !== undefined && !/^\+[1-9][0-9]{7,14}$/.test(n)) {
    throw new Error(`--number must be in +1XXXXXXXXXX format, got "${n}"`);
  }
}

function showPassword(username, password) {
  console.log('');
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${password}`);
  console.log('');
  console.log('  This password is shown once and is not stored anywhere. Send it to them privately.');
  console.log('');
}

async function main() {
  const { command, username, opts } = parseArgs(process.argv.slice(2));
  checkNumber(opts.callerId);
  await db.init();

  switch (command) {
    case 'add': {
      if (!username) throw new Error('usage: add <username> [--number ...] [--email ...] [--admin]');
      if (await db.getUserByUsername(username)) throw new Error(`"${username}" already exists. Use reset-password or set.`);
      const password = db.generatePassword();
      const u = await db.createUser({ username, password, ...opts });
      console.log(`Created ${u.username}${u.is_admin ? ' (admin)' : ''}, caller ID: ${u.caller_id || 'default number'}`);
      showPassword(u.username, password);
      break;
    }
    case 'reset-password': {
      if (!username) throw new Error('usage: reset-password <username>');
      const password = db.generatePassword();
      const u = await db.updateUser(username, { password });
      if (!u) throw new Error(`no user "${username}"`);
      console.log(`New password for ${u.username} (they've been logged out everywhere):`);
      showPassword(u.username, password);
      break;
    }
    case 'set': {
      if (!username) throw new Error('usage: set <username> [--number ...] [--email ...] [--admin|--not-admin]');
      const u = await db.updateUser(username, opts);
      if (!u) throw new Error(`no user "${username}"`);
      console.log(`Updated ${u.username}: admin=${u.is_admin}, caller ID=${u.caller_id || 'default number'}, email=${u.email || '-'}`);
      break;
    }
    case 'list': {
      const users = await db.listUsers();
      if (!users.length) console.log('No accounts yet.');
      for (const u of users) {
        console.log(`${u.username.padEnd(16)} ${u.is_admin ? 'admin' : 'rep  '}  ${(u.caller_id || 'default number').padEnd(14)}  ${u.email || ''}`);
      }
      break;
    }
    case 'remove': {
      if (!username) throw new Error('usage: remove <username>');
      const ok = await db.deleteUser(username);
      console.log(ok ? `Removed ${username}. Their leads stay in the CRM as "Unassigned".` : `No user "${username}".`);
      break;
    }
    default:
      console.log('Commands: add, reset-password, set, list, remove. See the top of scripts/users.js.');
  }
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
