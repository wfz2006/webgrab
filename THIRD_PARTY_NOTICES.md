# Third-party notices

## Mozilla Readability

WebGrab bundles the standalone Mozilla Readability library locally for its
on-demand novel/article extraction feature.

- Package: `@mozilla/readability`
- Version: `0.6.0`
- Source: <https://github.com/mozilla/readability/tree/0.6.0>
- Vendored file: `lib/readability.js`
- SHA-256: `34DCAB3D0832D0019F02990EED6B6124E029E8C32B9F0C6F2550544FF8DFF174`
- Copyright: Copyright (c) 2010 Arc90 Inc
- License: Apache License 2.0
- License copy: `lib/readability.LICENSE.txt`

The vendored source is kept unmodified and retains its original copyright and
license header. It is loaded only from the extension package; WebGrab does not
execute a remote copy.

## fflate

WebGrab bundles fflate locally for streaming CBZ and EPUB ZIP creation.

- Package: `fflate`
- Version: `0.8.3`
- Source: <https://github.com/101arrowz/fflate>
- Vendored file: `lib/fflate.min.js` (official npm UMD build)
- SHA-256: `462EF8041FC970E3615A20A9DD2B2E3047A073B2DA729EF4F02B634BBA8B7B83`
- Copyright: Copyright (c) 2026 Arjun Barrett
- License: MIT
- License copy: `lib/fflate.LICENSE.txt`

The archive library is loaded only from the extension package. No CDN or
remote executable copy is referenced at runtime.
