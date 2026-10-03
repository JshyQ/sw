// Small terminal logger so you can see what the bot is doing step by step.
// Usage: const { makeLog, secs } = require('./botlog'); const log = makeLog('tt'); log('Downloading...');
const chalk = require('chalk');

const COLORS = { info: chalk.cyan, ok: chalk.green, warn: chalk.yellow, err: chalk.red };

const makeLog = (tag) => (msg, kind = 'info') => {
    const time = new Date().toLocaleTimeString('en-GB');
    console.log(chalk.gray(`[${time}]`), (COLORS[kind] || COLORS.info)(`[${tag}]`), msg);
};

const secs = (start) => ((Date.now() - start) / 1000).toFixed(1) + 's';

module.exports = { makeLog, secs };
