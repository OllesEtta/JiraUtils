import { timesInStatusesForTicket, getKeysInJQL } from './lib/lib';
import { Config, TicketStatusTimes } from './lib/interfaces';
import * as fs from 'fs';
import * as yargs from 'yargs';
const config = <Config>require('./config.json');

const lowercaseStatuses = config.statuses
    .map(status => status.toLowerCase())
const statuses = lowercaseStatuses
    .map(status => status.replace('*', ''));
const finalStatuses = lowercaseStatuses
    .filter(status => status.indexOf('*') >= 0)
    .map(status => status.replace('*', ''));

if (finalStatuses.length === 0) {
    const finalStatusGuess = statuses[statuses.length - 1];
    console.log(`No status marked as final in the config.json. Guessing '${finalStatusGuess}' as the final status`);
    console.log('Mark the statuses that close a ticket with a "*" before the status name in your config.json');
    console.log();
    finalStatuses.push(finalStatusGuess);
}

const argv = yargs.argv;
let keys = <string[]>(argv.query ? [] : argv._);
const query = <string>(argv.query ? argv.query : null);
const file = <string>(argv.file ? argv.file : null);

function prettyPrintTimes(values: { [key: string]: number }, statuses: string[]): string {
    return statuses
        .map(s => s.toLowerCase())
        .map(s => values[s] || 0)
        .join(',');
}

function prettyPrintDate(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

async function getTicketTimeStrings(keys: string[]): Promise<string[]> {
    const heading = [`Key,Created,Finished,${config.statuses.map(s => s.replace('*', '')).join(',')}`];

    const timePromises = keys.map(key => timesInStatusesForTicket(key, config.jira, finalStatuses));
    const timeResults = await Promise.all(timePromises);

    const lines = timeResults.map(times => times.key
        + ',' + prettyPrintDate(times.created)
        + ',' + ((times.finished) ? prettyPrintDate(times.finished) : '')
        + ',' + prettyPrintTimes(times.times, config.statuses)
    );

    return heading.concat(lines);
}

(async () => {
    if (query) {
        keys = await getKeysInJQL(query, config.jira);
    }

    if (keys.length > 0) {
        const strings = await getTicketTimeStrings(keys);

        if (!file) {
            strings.forEach((line) => { console.log(line) });
        } else {
            console.log(`Writing to ${file}`);
            fs.writeFileSync(file, strings.join("\n"), { encoding: 'utf-8' });
            console.log(`Success!`);
        }

    } else {
        console.log(`
run [--file=FILE_NAME] [--query=JQL | KEY1 [KEY2 [...]]]

Example: run --file=out.csv --query="project in (br,pay) and type in (bug,task,story) and status = done
Example: run --file=out.csv br-1 pay-1
Example: run pay-4000
`);
        process.exit(0);
    }
})();
