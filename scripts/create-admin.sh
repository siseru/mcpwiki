#!/usr/bin/env bash
# Create (invite) a user in the MCPWiki user pool and add them to a group.
# Usage: scripts/create-admin.sh <dev|prod> <username> <email> [admin|editor|viewer]
set -euo pipefail
env_name="${1:?env (dev|prod)}"; username="${2:?username}"; email="${3:?email}"; group="${4:-admin}"
# Same region as the CDK app (cdk.json context.region); override with MCPWIKI_REGION. AWS_REGION is ignored on
# purpose: it is often set for other work (e.g. us-east-1) and would silently target the wrong user pool.
region="${MCPWIKI_REGION:-$(node -p "require('./cdk.json').context.region")}"
pool_id="$(aws cloudformation describe-stacks --region "$region" --stack-name "MCPWiki-${env_name}" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)"
aws cognito-idp admin-create-user --region "$region" --user-pool-id "$pool_id" --username "$username" \
  --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL --query 'User.Username' --output text
aws cognito-idp admin-add-user-to-group --region "$region" --user-pool-id "$pool_id" --username "$username" --group-name "$group"
echo "invited ${username} <${email}> as ${group}; a temporary password was emailed."
