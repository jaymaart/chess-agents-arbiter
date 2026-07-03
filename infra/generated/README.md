# Infrastructure spec spec_08f413f9-1086-45d2-be80-866a2de935d6_1

This PR includes review-only Terraform files under `infra/` and the source infrastructure spec under `infra/generated/`.

Environment: Staging
Cloud: hetzner
Region: local

## Services
- app: backend
- docker-sandbox: backend

## Review
- SSH ingress is disabled until an allowlist is reviewed.
- No configured provider credentials were used; no real cloud APIs were called.
