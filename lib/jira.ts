import { Issue, HasChangelog, HistoryItem, IssueQueryResponse, JiraConfig, IssueTimings, History } from "./interfaces";
import request from "request-promise-native";
import dateFormat from "dateformat";

async function getIssueDetails(key: string, jira: JiraConfig): Promise<Issue & HasChangelog> {
    const issueDetails = <Issue & HasChangelog>(
        JSON.parse(await request(`${jira.url}/rest/api/2/issue/${key}?expand=changelog`, { auth: jira }))
    );

    if (issueDetails.changelog.maxResults < issueDetails.changelog.total) {
        throw new Error(
            `${key} has more changelog events than what we can process ` +
                `with the current Jira API (Got ${issueDetails.changelog.maxResults} ` +
                `event(s), but it has ${issueDetails.changelog.total}`
        );
    }
    return issueDetails;
}

function getIssueStatusEvents(issue: Issue & HasChangelog): History[] {
    const statusChangeHistories = issue.changelog.histories.filter(history => {
        const statusItem = history.items.find(item => item.field === "status");
        return (
            statusItem !== undefined &&
            statusItem.from != null &&
            statusItem.to != null &&
            statusItem.from !== statusItem.to
        );
    });

    return statusChangeHistories;
}

export class Jira {
    public static async JQL_forEach(
        jql: string,
        jira: JiraConfig,
        cb: (issue: Issue) => any,
        expand?: string
    ): Promise<void> {
        let getParams = [`jql=${jql}`];
        if (expand) getParams.push(`expand=${expand}`);

        const getParam = getParams.length == 0 ? "" : `?${getParams.join("&")}`;

        let uri = `${jira.url}/rest/api/2/search${getParam}`;
        let hasMorePages = false;
        let startAt = 0;
        console.log(`Fetching all results from URI ${uri}`);
        do {
            const result = <IssueQueryResponse>JSON.parse(await request(`${uri}&startAt=${startAt}`, { auth: jira }));
            console.log(`Got ${result.startAt}..${result.startAt + result.maxResults}/${result.total}`);

            result.issues.forEach(cb);

            hasMorePages = result.startAt + result.maxResults < result.total;
            startAt = result.startAt + result.maxResults;
        } while (hasMorePages);
        console.log("Done fetching");
        console.log();
    }

    public static async JQL_withChangelog<T extends Issue & HasChangelog>(jql: string, jira: JiraConfig): Promise<T[]> {
        return <Promise<T[]>>this.JQL(jql, jira, "changelog");
    }
    public static async JQL(jql: string, jira: JiraConfig, expand?: string): Promise<Issue[]> {
        const collector: Issue[] = [];
        await this.JQL_forEach(jql, jira, issue => collector.push(issue), expand);
        return collector;
    }

    public static getIssueTimings(issue: Issue & HasChangelog, finalStatuses: string[]): IssueTimings {
        const statusChangeHistories = getIssueStatusEvents(issue);
        const issueCreatedDate = new Date(statusChangeHistories[0].created);

        let doneTime: Date = null;
        let prevStatus: string = null;
        let prevStatusStartTime: Date = issueCreatedDate;
        const timeInStatuses: { [status: string]: number } = {};

        statusChangeHistories.forEach(statusChangeHistory => {
            /* There shouldn't be many status changes in one history entry,
             * but just in case, we'll take the last one */
            const statusChange = statusChangeHistory.items.reverse().find(item => item.field === "status");

            const newStatusStartTime = new Date(statusChangeHistory.created);
            const newStatus = statusChange.toString.toLowerCase();
            const secondsInPreviousStatus = newStatusStartTime.getTime() - prevStatusStartTime.getTime();

            if (prevStatus === null) prevStatus = statusChange.fromString.toLowerCase();

            if (!timeInStatuses[prevStatus]) timeInStatuses[prevStatus] = 0;
            timeInStatuses[prevStatus] += secondsInPreviousStatus;

            prevStatus = newStatus;
            prevStatusStartTime = newStatusStartTime;

            if (finalStatuses.indexOf(newStatus) >= 0) doneTime = newStatusStartTime;
        });

        const secondsInPreviousStatus = new Date().getTime() - prevStatusStartTime.getTime();
        if (!timeInStatuses[prevStatus]) timeInStatuses[prevStatus] = 0;
        timeInStatuses[prevStatus] += secondsInPreviousStatus;

        return {
            key: issue.key,
            summary: issue.fields.summary,
            created: issueCreatedDate,
            finished: doneTime,
            times: timeInStatuses
        };
    }

    public static async getKeysLandedInStatusDuringTimePeriod(
        project: string,
        from: Date,
        to: Date,
        statuses: string[],
        jira: JiraConfig
    ): Promise<string[]> {
        statuses = statuses.map(status => status.toLowerCase());
        const keysThatWereUpdatedInAnyWay: string[] = (await this.JQL(
            `project = ${project} and ` +
                `type in (story, task) and ` +
                `updatedDate >= ${dateFormat(from, "yyyy-mm-dd")} and ` +
                `updatedDate <= ${dateFormat(to, "yyyy-mm-dd")}`,
            jira
        )).map(issue => issue.key);

        async function returnSelfIfCompletedDuringTheDate(key: string): Promise<string> {
            const statusIsAFinishingStatus = (statusItem: HistoryItem) =>
                statuses.indexOf(statusItem.toString.toLowerCase()) >= 0;
            const details = await getIssueDetails(key, jira);
            const statusHistory = getIssueStatusEvents(details);

            if (statusHistory.length === 0) {
                // Issue has not transitioned at all yet
                return null;
            }

            let firstFinishedStatus: History = null;
            for (let i = statusHistory.length - 1; i > 0; i--) {
                const status = statusHistory[i];
                const statusItem = status.items[0];

                if (statusIsAFinishingStatus(statusItem)) {
                    firstFinishedStatus = status;
                } else {
                    break;
                }
            }

            if (firstFinishedStatus !== null) {
                const statusDate = new Date(firstFinishedStatus.created);
                if (from <= statusDate && statusDate <= to) {
                    return key;
                } else {
                    // Issue is completed, but got first completed outside of the given time range.
                }
            } else {
                // Issue is not completed currently.
                // Either hasn't got that far yet, or has been taken back from the progress.
            }

            return null;
        }

        const promises: Promise<string>[] = [];
        keysThatWereUpdatedInAnyWay.forEach(key => {
            promises.push(returnSelfIfCompletedDuringTheDate(key));
        });
        return (await Promise.all(promises)).filter(keyOrFalsy => !!keyOrFalsy).sort();
    }

    public static issueHasChangelog<IssueWithChangelog extends Issue & HasChangelog>(
        issue: Issue
    ): issue is IssueWithChangelog {
        return !!issue["changelog"];
    }

    public static issuesHaveChangelogs<IssueWithChangelog extends Issue & HasChangelog>(
        issues: Issue[]
    ): issues is IssueWithChangelog[] {
        for (var i = 0; i < issues.length; i++) {
            if (!this.issueHasChangelog(issues[i])) return false;
        }
        return true;
    }
}
