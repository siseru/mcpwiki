"""Architecture diagrams with official AWS icons (https://diagrams.mingrammer.com).

Regenerate (requires Graphviz):
    python3 -m venv .venv && .venv/bin/pip install diagrams==0.25.1
    .venv/bin/python scripts/diagrams/architecture.py
Outputs docs/images/architecture.png and docs/images/cicd-security.png.
"""
from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.integration import SNS
from diagrams.aws.management import Cloudformation, Cloudwatch, SystemsManagerParameterStore
from diagrams.aws.network import APIGateway, CloudFront, Route53
from diagrams.aws.security import IAMPermissions, IAMRole, WAF, CertificateManager, Cognito, SecretsManager
from diagrams.aws.storage import Backup, SimpleStorageServiceS3
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.client import Client, Users
from diagrams.onprem.vcs import Github

OUT = Path(__file__).resolve().parents[2] / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
GRAPH = {"splines": "spline", "fontsize": "20", "pad": "0.4", "nodesep": "0.7", "ranksep": "1.0", "fontname": "Helvetica"}
NODE = {"fontsize": "12", "fontname": "Helvetica"}

with Diagram("MCPWiki - runtime architecture", filename=str(OUT / "architecture"), show=False, direction="LR",
             graph_attr=GRAPH, node_attr=NODE, outformat="png"):
    with Cluster("Clients"):
        users = Users("Browser\n(user / admin UI)")
        agents = Client("MCP clients\n(Claude Code etc.)")
        cli = Client("mcpwiki CLI\n(+ MCP stdio bridge)")

    with Cluster("Edge (global; certificate + WAF in us-east-1)"):
        dns = Route53("Route 53\n<host>, auth.<host>\n(CAA: amazon.com)")
        cdn = CloudFront("CloudFront\nTLS 1.2+, CSP / HSTS\ncanonical-host redirect")
        acm = CertificateManager("ACM\n(DNS-validated,\nauto-renewed)")
        waf = WAF("AWS WAF (prod)\nIP rate limit,\nmanaged rules")

    with Cluster("Region (us-west-2)"):
        idp = Cognito("Cognito managed login\nMFA (TOTP) required")
        web = SimpleStorageServiceS3("S3: SPA assets\n(OAC only)")
        with Cluster("API / MCP"):
            api = APIGateway("HTTP API\n(throttling)")
            fn = Lambda("Lambda (Node.js 24)\nREST + MCP Streamable HTTP\nJWT verify / authz / rate limit")
            secret = SecretsManager("Origin secret")
            params = SystemsManagerParameterStore("Runtime config")
        with Cluster("Data"):
            ddb = Dynamodb("DynamoDB\nmetadata, search index,\ngraph, audit (PITR)")
            content = SimpleStorageServiceS3("S3: articles\nOKF Markdown\n(versioned = history)")
            backup = Backup("AWS Backup (prod)\nvault lock")
        with Cluster("Operations"):
            cw = Cloudwatch("CloudWatch\nlogs + alarms")
            sns = SNS("SNS")

    for c in (users, agents, cli):
        c >> Edge(label="HTTPS" if c is users else "") >> dns
    dns >> cdn
    acm >> Edge(style="dotted", constraint="false") >> cdn
    waf >> Edge(style="dotted", constraint="false") >> cdn
    cdn >> Edge(label="/ (static)") >> web
    cdn >> Edge(label="/api/*, /mcp\n+ x-origin-verify") >> api >> fn
    dns >> Edge(label="auth.<host>: sign-in (PKCE)", style="dashed") >> idp
    fn >> Edge(label="JWKS", style="dotted") >> idp
    fn >> ddb
    fn >> content
    fn >> Edge(style="dotted") >> secret
    fn >> Edge(style="dotted") >> params
    backup >> Edge(style="dotted", constraint="false") >> ddb
    backup >> Edge(style="dotted", constraint="false") >> content
    fn >> Edge(style="dotted") >> cw >> sns

with Diagram("MCPWiki - CI/CD and dev/prod isolation (shared account)", filename=str(OUT / "cicd-security"), show=False,
             direction="LR", graph_attr=GRAPH, node_attr=NODE, outformat="png"):
    gh = Github("GitHub\nsiseru/mcpwiki")
    with Cluster("GitHub Actions"):
        checks = GithubActions("CI + Security\nlint / tests / cdk-nag\nCodeQL / checkov / zizmor\ngitleaks / dep review / ZAP")
        build = GithubActions("Deploy: build job\n(no cloud credentials)\nsynth -> cdk.out")
        deploy = GithubActions("Deploy: deploy job\nOIDC token (job-scoped)")
    with Cluster("AWS account"):
        with Cluster("dev (qualifier mwdev)"):
            dev_role = IAMRole("mcpwiki-github-deploy-dev\nsub = env:dev, ref:main")
            dev_boot = IAMRole("cdk-mwdev-* roles\n(deploy / exec / publish)")
            boundary = IAMPermissions("MCPWikiDevBoundary\n(no prod, no IAM/STS escape,\nown DNS names only)")
            dev_stacks = Cloudformation("MCPWiki-dev\nMCPWiki-dev-edge")
        with Cluster("prod (default bootstrap)"):
            prod_role = IAMRole("mcpwiki-github-deploy-prod\nsub = env:prod, ref:tags/v*\n+ required reviewers")
            prod_boot = IAMRole("cdk-hnb659fds-* roles")
            prod_stacks = Cloudformation("MCPWiki-prod\nMCPWiki-prod-edge")
        guard = Cloudformation("MCPWiki-guard\n(admin-deployed)")

    gh >> checks
    gh >> Edge(label="push main / tag v*") >> build >> Edge(label="artifact") >> deploy
    deploy >> Edge(label="main") >> dev_role >> dev_boot >> dev_stacks
    deploy >> Edge(label="v* + approval") >> prod_role >> prod_boot >> prod_stacks
    boundary - Edge(style="dashed", color="firebrick") - dev_boot
    boundary - Edge(style="dashed", color="firebrick") - dev_role
    dev_boot >> Edge(label="denied", style="dashed", color="firebrick") >> prod_stacks
    guard >> Edge(style="dotted") >> boundary
