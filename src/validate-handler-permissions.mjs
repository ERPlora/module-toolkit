// The permission CEILING of a Tier-2 handler (ERPlora/hub#459, step 3).
//
// A handler returns `Operation`s and `commands::validate_operation` resolves them to SQL with three
// rules: the op is `kind == "sql"`, the target command exists, and it belongs to the SAME module.
// It never checks the target's PERMISSION. So a command a cashier may run can, through its handler,
// reach the SQL of a command reserved for a manager — and with the PIN elevation of hub#361 live,
// "a manager approves this" becomes a promise the runtime makes and any `module.json` can break
// without meaning to.
//
// Closing it properly (a permission check inside `validate_operation`) breaks 84 crossings across
// 12 published modules, which is a catalog migration and not a fix. hub#459 therefore takes the
// incremental path, and step 3 is this: `erplora validate` WARNS, the author sees the crossing at
// build time, and the catalog is realigned module by module without 403-ing live flows. So these
// are warnings and must stay warnings until the realignment lands.
//
// The rule being checked, stated as the contract hub#459 proposes (option 4): the permission of a
// command with a handler is the CEILING of everything its op chain may touch. A crossing exists
// when some role holds the parent's permission but NOT the target's — that role reaches the
// target's SQL through the handler and could never reach it through the front door.
//
// How reachability is decided: the same conservative sweep hub#459 ran by hand — the command names
// the handler's own code names LITERALLY. We start at the function the manifest routes to, walk the
// local call graph transitively, and collect string literals that match a command of this module.
// A lexical walk, no Rust parser: comments and the bodies of unreached functions are out, but a
// literal built by string concatenation is invisible. It under-reports, never over-reports, which
// is the right direction for a warning nobody asked for.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every `.rs` under `handler/src`, recursively. Empty = no source shipped, nothing to analyze. */
function readHandlerSources(dir) {
  const root = join(dir, 'handler', 'src');
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.rs')) out.push(readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

/**
 * Strips Rust comments, keeping the string literals intact (a `//` inside a string is not a
 * comment, and a command name inside a comment is not an operation). Replaces the removed text with
 * spaces so that every remaining byte keeps its offset — the brace matching below depends on it.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const start = i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
      out += src.slice(start, Math.min(i + 1, src.length));
      i += 1;
    } else if (c === "'" && /['\\ -~]/.test(src[i + 1] ?? '') && (src[i + 2] === "'" || src[i + 1] === '\\')) {
      // A char literal (`'}'`, `'\n'`) — not a lifetime (`'a,`), which has no closing quote.
      const start = i;
      i += src[i + 1] === '\\' ? 4 : 3;
      out += src.slice(start, i);
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out += ' ', i++;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      out += '  ';
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') (depth += 1), (out += '  '), (i += 2);
        else if (src[i] === '*' && src[i + 1] === '/') (depth -= 1), (out += '  '), (i += 2);
        else (out += src[i] === '\n' ? '\n' : ' '), (i += 1);
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Maps every `fn NAME` of a Rust source to its BODY (braces balanced, comments already gone).
 * Overloads cannot exist in Rust, but the same name may appear in two `impl` blocks; the bodies are
 * concatenated so nothing is lost.
 */
export function collectRustFunctions(source) {
  const src = stripComments(source);
  const fns = new Map();
  const signature = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{;]*>)?\s*\(/g;
  let m;
  while ((m = signature.exec(src)) !== null) {
    // From the argument list to the opening brace of the body, skipping the return type.
    let i = src.indexOf('(', m.index + m[0].length - 1);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const open = src.indexOf('{', i);
    if (open < 0) continue;
    const semicolon = src.indexOf(';', i); // A trait method with no body: `fn f(&self) -> T;`
    if (semicolon >= 0 && semicolon < open) continue;
    let braces = 0;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      const c = src[j];
      if (c === '"') {
        j += 1;
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
        continue;
      }
      if (c === "'" && src[j + 1] && src[j + 2] === "'") {
        j += 2;
        continue;
      }
      if (c === '{') braces += 1;
      else if (c === '}') {
        braces -= 1;
        if (braces === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    const body = src.slice(open + 1, end);
    fns.set(m[1], fns.has(m[1]) ? `${fns.get(m[1])}\n${body}` : body);
    signature.lastIndex = open + 1; // Nested `fn`s inside this body are picked up on their own turn.
  }
  return fns;
}

/** The string literals of a body, unescaped enough to compare against a command name. */
function stringLiterals(body) {
  const out = new Set();
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.add(m[1]);
  return out;
}

/**
 * Every string literal reachable from `entry` through the LOCAL call graph, transitively. A
 * function counts as called when its name appears followed by `(` — good enough for a lexical
 * sweep, and erring towards reaching more code (a warning that fires is cheaper than one that does
 * not). Recursion terminates on the visited set.
 */
function literalsReachableFrom(fns, entry) {
  const literals = new Set();
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const body = fns.get(name);
    if (body === undefined) continue;
    for (const lit of stringLiterals(body)) literals.add(lit);
    for (const candidate of fns.keys()) {
      if (seen.has(candidate)) continue;
      if (new RegExp(`\\b${candidate}\\s*\\(`).test(body)) pending.push(candidate);
    }
  }
  return literals;
}

/**
 * The roles that hold `parentPermission` but not `targetPermission` — the ones a crossing lets
 * through a door they cannot open themselves. `*` in a role's list means every permission.
 */
export function rolesLosingAccess(rolePermissions, parentPermission, targetPermission) {
  const holds = (perms, permission) =>
    Array.isArray(perms) && (perms.includes('*') || perms.includes(permission));
  return Object.entries(rolePermissions ?? {})
    .filter(([, perms]) => holds(perms, parentPermission) && !holds(perms, targetPermission))
    .map(([role]) => role);
}

/**
 * Warns about every command reachable from a handler whose permission is STRICTER than the
 * handler's own command (hub#459 step 3).
 *
 * Returns `{ checked, warnings }`:
 * - `checked: false` → nothing was analyzed (no handler declared, or no Rust source shipped, which
 *   is the shape of a third-party module distributing only `dist/handler.wasm`).
 * - `warnings` → one line per (command with handler → command it reaches) crossing.
 */
export function checkHandlerPermissionCeiling(dir, manifest) {
  const commands = manifest.commands ?? {};
  const entries = Object.entries(commands).filter(([, c]) => typeof c?.handler?.function === 'string');
  if (!entries.length) return { checked: false, warnings: [] };

  const sources = readHandlerSources(dir);
  if (!sources.length) return { checked: false, warnings: [] };

  const fns = new Map();
  for (const src of sources) {
    for (const [name, body] of collectRustFunctions(src)) {
      fns.set(name, fns.has(name) ? `${fns.get(name)}\n${body}` : body);
    }
  }

  const rolePermissions = manifest.role_permissions;
  const hasRoles = rolePermissions && typeof rolePermissions === 'object' && Object.keys(rolePermissions).length > 0;

  const warnings = [];
  for (const [name, command] of entries) {
    if (!fns.has(command.handler.function)) continue; // Routed to a function this source does not define.
    const parentPermission = command.permission;
    for (const literal of literalsReachableFrom(fns, command.handler.function)) {
      if (literal === name) continue;
      const target = commands[literal];
      // The runtime's own three rules: same module, and a command with declarative SQL behind it.
      // Anything else is already rejected loudly by `validate_operation`, and saying it twice here
      // would only bury the finding that matters.
      if (!target || !Array.isArray(target.sql) || target.sql.length === 0) continue;
      if (!literal.startsWith(`${manifest.id}.`)) continue;
      if (target.permission === parentPermission) continue;

      const head =
        `[handler-permission-ceiling] \`${name}\` (permiso \`${parentPermission}\`) alcanza por ` +
        `handler el SQL de \`${literal}\` (permiso \`${target.permission}\`)`;
      if (!hasRoles) {
        warnings.push(
          `${head}: el manifest no declara \`role_permissions\`, así que no se puede decir qué rol ` +
            `se cuela — pero el permiso del command con handler es el TECHO de su cadena de ops ` +
            `(hub#459), y aquí no lo es.`,
        );
        continue;
      }
      const losing = rolesLosingAccess(rolePermissions, parentPermission, target.permission);
      if (!losing.length) continue;
      warnings.push(
        `${head}, y ${losing.map((r) => `\`${r}\``).join(', ')} tiene el primero pero NO el ` +
          `segundo: por la puerta de delante se le niega y por el handler pasa. El permiso del ` +
          `command con handler es el TECHO de todo lo que su cadena de ops toca (hub#459): iguala ` +
          `el permiso de \`${literal}\` al de \`${name}\`, o parte el command en dos.`,
      );
    }
  }
  return { checked: true, warnings };
}
