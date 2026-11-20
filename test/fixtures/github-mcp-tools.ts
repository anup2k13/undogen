/**
 * Tool definitions shaped like GitHub's official MCP server (github-mcp-server), trimmed to
 * what the planner reads: names, input schemas and the `method` options of its multi-action
 * tools (`sub_issue_write` lists them only in its description).
 */
import type { McpTool } from '../../src/wrap/plans.js';

const s = { type: 'string' };
const n = { type: 'number' };
const repo = { owner: s, repo: s };

export const githubTools: McpTool[] = [
  {
    name: 'issue_read',
    inputSchema: {
      type: 'object',
      properties: { ...repo, issue_number: n, method: { type: 'string', enum: ['get', 'get_comments', 'get_sub_issues', 'get_parent', 'get_labels'] } },
      required: ['method', 'owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'issue_write',
    inputSchema: {
      type: 'object',
      properties: {
        ...repo,
        method: { type: 'string', enum: ['create', 'update'] },
        issue_number: n,
        title: s,
        body: s,
        labels: { type: 'array', items: s },
        assignees: { type: 'array', items: s },
        milestone: n,
        parent_issue_number: n,
        state: { type: 'string', enum: ['open', 'closed'] },
        state_reason: { type: 'string', enum: ['completed', 'not_planned', 'duplicate'] },
      },
      required: ['method', 'owner', 'repo'],
    },
  },
  {
    name: 'sub_issue_write',
    inputSchema: {
      type: 'object',
      properties: {
        ...repo,
        issue_number: n,
        sub_issue_id: n,
        replace_parent: { type: 'boolean' },
        after_id: n,
        before_id: n,
        method: {
          type: 'string',
          description:
            "The action to perform on a single sub-issue\nOptions are:\n- 'add' - add a sub-issue to a parent issue in a GitHub repository.\n- 'remove' - remove a sub-issue from a parent issue in a GitHub repository.\n- 'reprioritize' - change the order of sub-issues within a parent issue in a GitHub repository.\n",
        },
      },
      required: ['method', 'owner', 'repo', 'issue_number', 'sub_issue_id'],
    },
  },
  {
    name: 'pull_request_read',
    inputSchema: {
      type: 'object',
      properties: { ...repo, pullNumber: n, method: { type: 'string', enum: ['get', 'get_diff', 'get_status', 'get_files', 'get_review_comments', 'get_reviews', 'get_comments'] } },
      required: ['method', 'owner', 'repo', 'pullNumber'],
    },
  },
  { name: 'create_branch', inputSchema: { type: 'object', properties: { ...repo, branch: s, from_branch: s }, required: ['owner', 'repo', 'branch'] } },
  { name: 'delete_file', inputSchema: { type: 'object', properties: { ...repo, path: s, message: s, branch: s }, required: ['owner', 'repo', 'path', 'message', 'branch'] } },
  {
    name: 'update_pull_request',
    inputSchema: { type: 'object', properties: { ...repo, pullNumber: n, title: s, body: s, state: { type: 'string', enum: ['open', 'closed'] }, base: s, draft: { type: 'boolean' } }, required: ['owner', 'repo', 'pullNumber'] },
  },
  { name: 'merge_pull_request', inputSchema: { type: 'object', properties: { ...repo, pullNumber: n, merge_method: s }, required: ['owner', 'repo', 'pullNumber'] } },
  { name: 'add_issue_comment', inputSchema: { type: 'object', properties: { ...repo, issue_number: n, body: s }, required: ['owner', 'repo', 'issue_number', 'body'] } },
];
