// Moves article ownership and attachment uploads from a deleted Cognito user to the re-invited user of the same
// username. Needed because Cognito has no admin API to clear a user's TOTP: in an MFA-required pool,
// AdminSetUserMFAPreference(Enabled=false) leaves the authenticator registered (verified on the dev pool,
// 2026-11), so the only reset is AdminDeleteUser + re-invite, which gives the user a new `sub`.
//
// What it changes (DynamoDB only; S3 bodies carry ownerName, which stays the same):
//   A#<id> META     owner          old sub -> new sub
//   A#<id> F#<file> uploadedBySub  old sub -> new sub
// Left as is: audit entries (history) and U#<old sub> STATE (state of the deleted account).
//
// Usage (administrator credentials; dry run unless --apply):
//   node scripts/reassign-owner.mjs <dev|prod> <username> [--from-sub <old sub>] [--apply]
// Exit codes: 0 done / nothing to do, 1 items still owned by the old sub after --apply, 2 refused (see message).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CognitoIdentityProviderClient, AdminGetUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--from-sub');
const [envName, username] = positional;
const apply = flag('--apply');
const fromSubArg = opt('--from-sub');
const refuse = (msg) => {
  console.error(`refused: ${msg}`);
  process.exit(2);
};
if (!['dev', 'prod'].includes(envName) || !username) refuse('usage: node scripts/reassign-owner.mjs <dev|prod> <username> [--from-sub <sub>] [--apply]');

// Same region rule as scripts/create-admin.sh: cdk.json, overridable by MCPWIKI_REGION; AWS_REGION is ignored.
const region = process.env.MCPWIKI_REGION ?? JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8')).context.region;
const stack = `MCPWiki-${envName}`;
const aws = (a) => execFileSync('aws', [...a, '--region', region, '--output', 'text'], { encoding: 'utf8' }).trim();
const poolId = aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue"]);
const tables = aws(['cloudformation', 'describe-stack-resources', '--stack-name', stack, '--query', "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId"]).split(/\s+/).filter(Boolean);
if (!poolId) refuse(`no UserPoolId output on ${stack}`);
if (tables.length !== 1) refuse(`expected one DynamoDB table in ${stack}, found ${tables.length}: ${tables.join(' ')}`);
const table = tables[0];

const cognito = new CognitoIdentityProviderClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

let newSub;
try {
  const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username }));
  newSub = u.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
} catch (e) {
  if (e?.name === 'UserNotFoundException') refuse(`${username} is not in ${poolId}; re-invite the user first (scripts/create-admin.sh)`);
  throw e;
}
if (!newSub) refuse(`${username} has no sub`);

/** Items of this username not owned by the new sub. */
async function scan() {
  const out = [];
  let start;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: '(SK = :meta AND ownerName = :name AND #o <> :new) OR (begins_with(SK, :f) AND uploadedBy = :name AND uploadedBySub <> :new)',
      ExpressionAttributeNames: { '#o': 'owner' },
      ExpressionAttributeValues: { ':meta': 'META', ':f': 'F#', ':name': username, ':new': newSub },
      ProjectionExpression: 'PK, SK, #o, uploadedBySub, deleted',
      ExclusiveStartKey: start,
    }));
    for (const it of res.Items ?? []) {
      const kind = it.SK === 'META' ? 'article' : 'attachment';
      out.push({ pk: it.PK, sk: it.SK, kind, attr: kind === 'article' ? 'owner' : 'uploadedBySub', oldSub: kind === 'article' ? it.owner : it.uploadedBySub, deleted: !!it.deleted });
    }
    start = res.LastEvaluatedKey;
  } while (start);
  return out;
}

const found = await scan();
const bySub = new Map(); // Map.groupBy needs Node 21; engines allows 20
for (const i of found) bySub.set(i.oldSub, [...(bySub.get(i.oldSub) ?? []), i]);
console.log(`env=${envName} pool=${poolId} table=${table}`);
console.log(`user=${username} new sub=${newSub}`);
console.log(`items named ${username} but not owned by the new sub: ${found.length}`);
for (const [sub, items] of bySub) console.log(`  old sub ${sub}: ${items.filter((i) => i.kind === 'article').length} articles, ${items.filter((i) => i.kind === 'attachment').length} attachments`);
if (found.length === 0) {
  console.log('nothing to do (0 items: check the username if you expected some)');
  process.exit(0);
}

const fromSub = fromSubArg ?? (bySub.size === 1 ? [...bySub.keys()][0] : refuse(`${bySub.size} different old subs; pick one with --from-sub`));
const targets = bySub.get(fromSub) ?? [];
if (targets.length === 0) refuse(`no items for --from-sub ${fromSub}`);
// The old account must be gone: otherwise this would take pages away from a live user.
const live = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `sub = "${fromSub.replace(/"/g, '')}"`, Limit: 1 }));
if ((live.Users ?? []).length > 0) refuse(`old sub ${fromSub} still belongs to user ${live.Users[0].Username}; delete that account first`);
const skipped = found.length - targets.length;
if (skipped) console.log(`skipped ${skipped} items of other old subs (not --from-sub)`);

for (const t of targets) console.log(`  ${apply ? 'update' : 'would update'} ${t.pk} ${t.sk} ${t.attr}${t.deleted ? ' (deleted article)' : ''}`);
if (!apply) {
  console.log(`dry run: ${targets.length} items would move ${fromSub} -> ${newSub}; re-run with --apply`);
  process.exit(0);
}

let updated = 0, changed = 0;
for (const t of targets) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { PK: t.pk, SK: t.sk },
      UpdateExpression: 'SET #a = :new',
      ConditionExpression: '#a = :old',
      ExpressionAttributeNames: { '#a': t.attr },
      ExpressionAttributeValues: { ':new': newSub, ':old': fromSub },
    }));
    updated++;
  } catch (e) {
    if (!(e instanceof ConditionalCheckFailedException)) throw e;
    changed++;
    console.log(`  not updated (changed meanwhile): ${t.pk} ${t.sk}`);
  }
}
console.log(`updated ${updated}, not updated ${changed}`);

const left = (await scan()).filter((i) => i.oldSub === fromSub);
if (left.length) {
  console.error(`still owned by ${fromSub}: ${left.length} items; re-run`);
  process.exit(1);
}
console.log(`done: no items left for ${fromSub}`);
