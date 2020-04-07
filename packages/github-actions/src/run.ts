import {
  SchemaPointer,
  ActionResult,
  CheckConclusion,
  Annotation,
  diff,
} from '@graphql-inspector/github';
import {buildSchema} from 'graphql';

import core from '@actions/core';
import github from '@actions/github';
import {Octokit} from '@octokit/rest';

const fs = require('fs');

const CHECK_NAME = 'GraphQL Inspector';

export async function run() {
  core.info(`GraphQL Inspector started`);

  // env
  const ref = process.env.GITHUB_SHA!;

  //
  // env:
  //   GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  //
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return core.setFailed('Env GITHUB_TOKEN is missing');
  }

  const octokit = new github.GitHub(token);

  // repo
  const {owner, repo} = github.context.repo;

  const check = await octokit.checks.create({
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: github.context.sha,
    status: 'in_progress',
  });
  const checkId = check.data.id;

  const existingSchema = core.getInput('existing-schema', {required: true});
  const newSchema = core.getInput('new-schema', {required: true});

  if (!existingSchema) {
    core.error('Missing `existing-schema` variable');
    return core.setFailed('Failed to find `existing-schema` variable');
  }

  if (!newSchema) {
    core.error('Missing `new-schema` variable');
    return core.setFailed('Failed to find `new-schema` variable');
  }

  const existingPointer: SchemaPointer = {
    path: existingSchema,
    ref,
  };
  const newPointer: SchemaPointer = {
    path: newSchema,
    ref,
  };

  const schemas = {
    old: buildSchema(loadFile(existingPointer)),
    new: buildSchema(loadFile(newPointer)),
  };

  core.info(`Both schemas built`);

  const actions: Array<Promise<ActionResult>> = [];

  core.info(`Comparing schemas...`);
  actions.push(
    diff({
      path: existingSchema,
      schemas,
    }),
  );

  const results = await Promise.all(actions);

  const conclusion = results.some(
    action => action.conclusion === CheckConclusion.Failure,
  )
    ? CheckConclusion.Failure
    : CheckConclusion.Success;

  const annotations = results.reduce<Annotation[]>((annotations, action) => {
    if (action.annotations) {
      return annotations.concat(action.annotations);
    }

    return annotations;
  }, []);

  const issueInfo = `Found ${annotations.length} issue${
    annotations.length > 1 ? 's' : ''
  }`;

  core.info(`${issueInfo}`);

  const issues = annotations.reduce( function (errorMessage, annot) { 
    return `${errorMessage}${annot.message}\n`;
  }, '')
  core.info(`${issues}`);

  const {title, summary} =
    conclusion === CheckConclusion.Failure
      ? {
          title: `Something is wrong with your schema: ${issueInfo}\n${issues}`,
          summary: issueInfo,
        }
      : {
          title: 'Everything looks good',
          summary: issueInfo,
        };

  try {
    await updateCheckRun(octokit, checkId, {
      conclusion,
      output: {title, summary, annotations},
    });
  } catch (e) {
    // Error
    core.error(e.message || e);
    return core.setFailed('Invalid config. Failed to add annotation');
  }
}

function loadFile(file: {path: string}): string {
  return fs.readFileSync(file.path, {encoding: 'utf8'});
}

type UpdateCheckRunOptions = Required<
  Pick<Octokit.ChecksUpdateParams, 'conclusion' | 'output'>
>;
async function updateCheckRun(
  octokit: github.GitHub,
  checkId: number,
  {conclusion, output}: UpdateCheckRunOptions,
) {
  await octokit.checks.update({
    check_run_id: checkId,
    completed_at: new Date().toISOString(),
    status: 'completed',
    ...github.context.repo,
    conclusion,
    output,
  });

  // Fail
  if (conclusion === CheckConclusion.Failure) {
    return core.setFailed(output.title!);
  }

  // Success or Neutral
}
