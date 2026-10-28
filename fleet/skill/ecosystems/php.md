# PHP (Composer)

Evidence: tanzu-genai-showcase#221 (php-symfony-neuron) only, and nothing there was built or
installed. Thin: treat this as a starting point.

## CI gates to find

- The PHP version in CI (8.3 in tanzu) **and** the deploy target's version: tanzu's Cloud Foundry
  buildpack sets `PHP_VERSION: {PHP_81_LATEST}` and `composer.json` says `"php": ">=8.1"`, while
  Symfony 7.3 needs 8.2+. CI green doesn't cover the deploy runtime (tanzu-genai-showcase#221).
- Whether `composer.lock` is committed. tanzu's isn't, so there is nothing to refresh and Composer
  resolves fresh each time.

## Audit

`composer audit` is Composer's built-in check; it wasn't run in the fleet. tanzu#221 used GitHub
alerts and the advisory API:

```bash
gh api '/advisories?ecosystem=composer&affects=symfony/yaml'
```

## Publish dates

```bash
curl -s https://repo.packagist.org/p2/<vendor>/<package>.json \
  | jq -r '.packages["<vendor>/<package>"][] | select(.version=="v<version>") | .time'
```

## Known traps

- **A minor-line pin blocks fixes and other bumps.** `symfony/*: 7.3.*`:
  - 7 Symfony alerts (mailer, mime, runtime, yaml) are fixed only in 7.4.12, so the constraint has
    to move to 7.4, a framework minor; 7.3 is end-of-life;
  - phpdocumentor/reflection-docblock 6 conflicts with it: symfony/property-info and serializer
    7.3.11 declare `conflict: phpdocumentor/reflection-docblock <5.2|>=6`. Without a lockfile,
    Composer either fails or quietly holds those packages at 7.3.10
    (tanzu-genai-showcase#221, #204).
- **PHP 8.1 is out of support.** php.net's supported-versions page (2026-10-23) no longer lists
  8.1, and 8.2's security support ends 2026-12-31 (<https://www.php.net/supported-versions.php>).
  symfony/monolog-bundle 4 needs PHP 8.2+, so raise the deploy runtime first
  (tanzu-genai-showcase#221, #176).
