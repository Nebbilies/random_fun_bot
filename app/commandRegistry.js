import { readdirSync } from 'node:fs';
import { parseFranchiseCommand } from '../lib/franchiseModifiers.js';
import { parseTopCommand } from '../lib/topModifiers.js';
const gameCommands = new Set(['affection', 'aff', 'soulmate', 'sm', 'help', 'char', 'im', 'ima', 'imar', 'divorce', 'w', 'h', 'mu', 'ru', 'daily', 'inv', 'itemlist', 'il', 'use', 'me', 'trade', 'give', 'cancel', 'top', 'topo', 'ts', 'tsl', 'topserv', 'wish', 'wl', 'wishlist']);
export function resolveGameCommand(token) {
    if (/^(mm|mymarry)([a-z]*)$/.test(token))
        return 'mm';
    if (parseFranchiseCommand(token))
        return 'ima';
    if (parseTopCommand(token))
        return 'top';
    if (['affection', 'aff'].includes(token))
        return 'affection';
    if (['soulmate', 'sm'].includes(token))
        return 'soulmate';
    return gameCommands.has(token) ? token : null;
}
export function loadPrefixCommand(name) {
    return import(new URL(`../commands/${name}.js`, import.meta.url).href);
}
export function hasLegacyCommand(name) {
    return readdirSync(new URL('../commands/', import.meta.url))
        .map(command => command.split('.').shift()).includes(name);
}
