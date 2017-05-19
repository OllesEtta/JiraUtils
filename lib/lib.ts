import * as request from 'request-promise-native';
import { Issue, Status, HistoryItem, IssueQueryResponse, JiraAuth, TicketStatusTimes } from './interfaces';
import fs = require('fs');

// FIXME: this can be removed by just checking the first "from" value in the status.
const INITIAL_STATUS = 'Idea';

const DONE_STATUS = 'Done';

export async function timesInStatusesForTicket(key: string, auth: JiraAuth): Promise<TicketStatusTimes> {
    const issueDetails = <Issue>JSON.parse(await request(`https://jira.lindorff.com/rest/api/2/issue/${key}?expand=changelog`, { auth: auth }));
    const issueCreatedDate = new Date(issueDetails.fields.created);

    if (issueDetails.changelog.maxResults < issueDetails.changelog.total) {
        throw new Error(`${key} has more changelog events than what we can process with the current Jira API (Got ${issueDetails.changelog.maxResults} event(s), but it has ${issueDetails.changelog.total}`);
    }

    const statusChangeHistories = issueDetails.changelog.histories.filter(history => {
        const statusItem = history.items.find(item => item.field === 'status')
        return statusItem !== undefined
            && statusItem.from != null
            && statusItem.to != null
            && statusItem.from !== statusItem.to;
    })

    let doneTime = null;
    let prevStatus = INITIAL_STATUS;
    let prevStatusStartTime = issueCreatedDate;
    const timeInStatuses: { [status: string]: number } = {};

    statusChangeHistories.forEach(statusChangeHistory => {

        /* There shouldn't be many status changes in one history entry, 
         * but just in case, we'll take the last one */
        const statusChange = statusChangeHistory.items
            .reverse()
            .find(item => item.field === 'status');

        const newStatusStartTime = new Date(statusChangeHistory.created);
        const newStatus = statusChange.toString.toLowerCase();
        const secondsInPreviousStatus = newStatusStartTime.getTime() - prevStatusStartTime.getTime();

        if (!timeInStatuses[prevStatus]) timeInStatuses[prevStatus] = 0;
        timeInStatuses[prevStatus] += secondsInPreviousStatus;

        prevStatus = newStatus;
        prevStatusStartTime = newStatusStartTime;

        if (newStatus === DONE_STATUS) doneTime = newStatusStartTime;
    });

    const secondsInPreviousStatus = new Date().getTime() - prevStatusStartTime.getTime();
    if (!timeInStatuses[prevStatus]) timeInStatuses[prevStatus] = 0;
    timeInStatuses[prevStatus] += secondsInPreviousStatus;

    return {
        key: key,
        created: issueCreatedDate,
        finished: doneTime,
        times: timeInStatuses
    }
};

export async function getKeysInJQL(jql: string, auth: JiraAuth): Promise<string[]> {
    const issues: string[] = [];

    let uri = `https://jira.lindorff.com/rest/api/2/search?jql=${jql}`;
    let hasMorePages = false;
    let startAt = 0;
    console.log(`Fetching all results from URI ${uri}`);
    do {
        const result = <IssueQueryResponse>JSON.parse(await request(`${uri}&startAt=${startAt}`, { auth: auth }));
        console.log(`Got ${result.startAt}..${result.startAt + result.maxResults}/${result.total}`);

        result.issues.forEach(issue => issues.push(issue.key));

        hasMorePages = (result.startAt + result.maxResults) < (result.total);
        startAt = result.startAt + result.maxResults;
    } while (hasMorePages);
    console.log('Done fetching');
    console.log();

    return issues;
}
