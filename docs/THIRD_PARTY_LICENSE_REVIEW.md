# Third-party license and notices review

## Automated inventory

The CI workflow generates a `third-party-license-inventory` artifact using the resolved npm dependency tree. Download the artifact from the relevant successful GitHub Actions run and retain it with the release records. It is a snapshot of the packages resolved in that run, not a legal opinion or proof of compatibility.

The inventory check fails for dependencies with missing, `UNKNOWN`, or `UNLICENSED` metadata (except the project itself). Any package whose metadata refers to a separate license file, unusual license expression, dual license, or non-standard license must be manually reviewed.

## Release checklist

- [ ] Generate inventory from the exact release build and archive the artifact.
- [ ] Review every direct and transitive dependency and its exact version.
- [ ] Verify license text and notices against the package's actual published files; metadata can be wrong or incomplete.
- [ ] Identify attribution, NOTICE, source-offer, patent, copyleft, trademark, font, icon, and redistribution requirements.
- [ ] Confirm whether the planned distribution model is hosted-only, container distribution, customer self-hosting, or source distribution; obligations may differ.
- [ ] Preserve all required third-party notices in the distributed product and source bundle.
- [ ] Review bundled assets and generated outputs, not only npm package metadata.
- [ ] Record reviewer, date, release commit, exceptions, and counsel's approval.
- [ ] Re-run the review whenever dependencies or the distribution model changes.

## Important limitations

The automated inventory does not establish that a dependency's license is compatible with a proprietary product. It cannot resolve all legal questions or guarantee that metadata is correct. Do not distribute a commercial release until a qualified reviewer has examined flagged packages and confirmed the applicable obligations.
