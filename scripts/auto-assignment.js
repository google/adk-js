// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export default async function ({github, context}) {
  let issueNumber;
  let activeAssigneesList;
  
  const issueAssigneesList = ['Varun-S10'];
  const prAssigneesList = ['Varun-S10'];

  if (context.payload.issue) {                     // For issue
    issueNumber = context.payload.issue.number;
    activeAssigneesList = issueAssigneesList;
    console.log('Event Type: Issue');
  } else if (context.payload.pull_request) {       // For PR
    issueNumber = context.payload.pull_request.number;
    activeAssigneesList = prAssigneesList;
    console.log('Event Type: Pull Request');
  } else {
    console.log('Not an issue or PR');
    return;
  }

  console.log('Target Assignee list:', activeAssigneesList);
  console.log('Entered auto assignment for number:', issueNumber);

  if (!activeAssigneesList || activeAssigneesList.length === 0) {
    console.log('No assignees found for this type.');
    return;
  }

  const noOfAssignees = activeAssigneesList.length;
  const selection = issueNumber % noOfAssignees;
  const assigneeToAssign = activeAssigneesList[selection];

  console.log(`Assigning #${issueNumber} to: ${assigneeToAssign}`);

  return github.rest.issues.addAssignees({
    issue_number: issueNumber,
    owner: context.repo.owner,
    repo: context.repo.repo,
    assignees: [assigneeToAssign],
  });
};
