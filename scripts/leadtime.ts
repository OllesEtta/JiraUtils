/*
Copyright 2018 Lindorff Oy

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Jira } from "../lib/jira";
import { Issue, HasChangelog, Config, Argv, Script } from "../lib/interfaces";
import * as fs from "fs";
import jiraConfig from "../config.jira.json";

const script: Script = async (config: Config, argv: Argv) => {
    let keys = <string[]>(argv.query ? [] : argv._);
    const query = <string>(argv.query ? argv.query : null);
    const file = <string>(argv.file ? argv.file : null);

    const statuses: string[] = config.statuses.map(status => status.name);
    const finalStatuses: string[] = config.statuses.filter(status => status.isDone).map(status => status.name);

    if (finalStatuses.length === 0) {
        console.error("No statuses marked as final. This is required for the script to work.");
        console.error('See readme.md and the section of "Status JSON Structure" for more info.');
        process.exit(1);
    }

    function showSummary(): boolean {
        if (argv.showSummary) {
            return true;
        } else if (argv.hideSummary) {
            return false;
        } else {
            const showSummary = config.scripts.leadtime.showSummary;
            return showSummary !== undefined ? showSummary : false;
        }
    }

    function prettyPrintTimes(values: { [key: string]: number }, statuses: string[]): string {
        return statuses
            .map(s => s.toLowerCase())
            .map(s => values[s] || 0)
            .join(",");
    }

    function prettyPrintDate(date: Date): string {
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }

    function getIssueTimeStrings<IssueWithChangelog extends Issue & HasChangelog>(
        issues: IssueWithChangelog[]
    ): string[] {
        const summary = showSummary() ? "Summary," : "";
        const heading = [`Key,Story Points,${summary}Created,Finished,${statuses.join(",")}`];

        const infoResults = issues.map(issue => Jira.getIssueTimings(issue, finalStatuses));

        const lines = infoResults.map(info => {
            const finished = info.finished ? prettyPrintDate(info.finished) : "";
            const summary = showSummary() ? `"${info.summary.replace('"', '\\"')}",` : "";
            return (
                info.key +
                "," +
                summary +
                prettyPrintDate(info.created) +
                "," +
                finished +
                "," +
                prettyPrintTimes(info.times, statuses)
            );
        });

        return heading.concat(lines);
    }

    let issues: Issue[] = [];
    if (query) {
        issues = await Jira.JQL(query, jiraConfig, "changelog");
    } else if (keys.length > 0) {
        issues = await Jira.JQL(`key in (${keys.join(",")})`, jiraConfig, "changelog");
    } else {
        console.log(`
    run --project=[project] leadtime [OPTIONS] [--query=JQL | KEY1 [KEY2 [...]]]
    
        --file=FILE_NAME
            Write output to a file instead of standard out.
        --showSummary
        --hideSummary
            Override the setting from config.project.*.json
    
    Example: run --project=foo leadtime --file=out.csv --query="project in (abc,bcd) and type in (bug,task,story) and status = done"
    Example: run --project=foo leadtime --file=out.csv ABC-1 BCD-1
    Example: run --project=foo leadtime ABC-1
    `);
        process.exit(0);
    }

    if (Jira.issuesHaveChangelogs(issues)) {
        const strings = await getIssueTimeStrings(issues);

        if (!file) {
            strings.forEach(line => {
                console.log(line);
            });
        } else {
            console.log(`Writing to ${file}`);
            fs.writeFileSync(file, strings.join("\n"), { encoding: "utf-8" });
            console.log(`Success!`);
        }
    } else {
        console.error("Tickets were not fetched properly :/");
    }
};

export = script;
