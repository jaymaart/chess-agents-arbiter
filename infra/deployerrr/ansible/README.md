# deployerrr Ansible review artifacts

These files describe how deployerrr will deploy and health-check project `e2990606-9d8e-4f71-92c9-68b7849fe07f` environment `08f413f9-1086-45d2-be80-866a2de935d6`.

- The playbooks use only the repository's root Compose file: not configured.
- They do not generate Caddy, Compose overrides, Dockerfile wrappers, migrations, firewall rules, or fallback services.
- `site.yml` expects a repository source archive named `deploy-source.tar.gz` beside the playbook at execution time.
- `health.yml` performs the periodic read-only Docker/Compose health check used by the dashboard monitor.
- `teardown.yml` runs `docker compose down --remove-orphans` from the managed release directory and intentionally keeps volumes, images, and uploaded source.
- Health status comes from container state and any `healthcheck` blocks defined by the repository's Compose services.
