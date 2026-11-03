# Commercial Licensing

_Note: This overview is provided for informational purposes and is not legal advice._

Orbit is open source under [AGPL-3.0-only](LICENSE). For equipment manufacturers, herd-management vendors, and software companies that want to build on Orbit without AGPL-3.0-only copyleft obligations, **AgroIntel** offers a paid commercial license.

## When you need a commercial license

You need a commercial license from AgroIntel if you plan to:

- Embed Orbit, the Orion agent sidecar (`@orion/agent`), the wire protocol (`@orbit/protocol`), or the connector SDK (`@orbit/connectors`) inside a proprietary or closed-source product.
- Distribute a modified or white-labeled version of the Orbit desktop app to your customers without publishing your modifications under AGPL-3.0-only.
- Run a hosted SaaS platform built on `@core/api` or `@orbit/sync` with proprietary extensions whose source code you do not make available to network users.

You **do not** need a commercial license to use unmodified Orbit on your own farm, or to distribute open-source modifications that comply in full with [AGPL-3.0-only](LICENSE).

## Separate paid offerings from AgroIntel

A commercial software license covers the code in this repository. AgroIntel also provides two separate paid offerings that are not part of the open-source codebase:

1. **Pecorva model weights:** Proprietary computer-vision models for cattle and horses, built to run on a local Jetson edge box in the barn or through our cloud API.
2. **Hosted Core & LLM gateway:** Managed Postgres + ElectricSQL cloud sync and a metered LLM gateway for farms and commercial partners that prefer not to manage their own cloud infrastructure or model API keys.

## Get in touch

To discuss commercial licensing, OEM partnerships, or access to Pecorva model weights and hosted APIs, contact Kristian Vastveit at [kristian@agrointel.no](mailto:kristian@agrointel.no).

See [LICENSING.md](LICENSING.md) for how the open-source and commercial licenses fit together.
