# Repository visibility and source protection

The GitHub repository is currently **public**. A proprietary LICENSE states reuse restrictions but does not prevent visitors from viewing, cloning, or downloading public source code. Licensing and confidentiality are different protections.

## Recommended action

If protecting the source code is more important than public portfolio visibility, change this repository to **private** in GitHub:

1. Open the repository and select **Settings**.
2. Under **General**, find **Danger Zone** / repository visibility.
3. Choose **Change visibility** and follow GitHub's confirmation steps.
4. Verify that only intended collaborators have access and review collaborator permissions.
5. Check any connected deployment, CI, and integration access after the change.

I have not changed visibility automatically because the available GitHub connection in this workspace supports repository reads and file commits, but does not expose a repository-visibility setting action. This document is not a claim that the repository is private.

## Before any commercial release

- Search current files and the Git history for credentials, private keys, tokens, customer data, and secrets. Rotate any secret that was ever committed; deleting a file from the latest commit does not remove it from history.
- Review contributor history and obtain appropriate written IP assignments or permissions before representing all code as solely owned.
- Keep public marketing material and private production code separate if you choose to maintain a public portfolio.
- Do not put production credentials or school personal data in GitHub, issues, test fixtures, or CI logs.
