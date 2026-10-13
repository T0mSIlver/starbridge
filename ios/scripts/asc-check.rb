# Signs in to App Store Connect with the API key that release.yml's testflight job uses, and says
# what fails before signing does: the key file's shape, the runner's clock, a key App Store Connect
# refuses (401), a role that may not manage signing (403), and each App ID's capabilities. It
# prints the key's public half's SHA-256, never the key, to compare with the .p8 kept offline:
#   openssl pkey -in AuthKey_<id>.p8 -pubout -outform DER | shasum -a 256
# Usage: ruby asc-check.rb <AuthKey_<id>.p8> <key id> <issuer id>
require_relative "asc"

$stdout.sync = true

path, kid, issuer = ARGV
abort "usage: asc-check.rb <p8> <key id> <issuer id>" unless path && kid && issuer
text = File.read(path)
pem = text.include?("-----BEGIN PRIVATE KEY-----") && text.include?("-----END PRIVATE KEY-----")
puts "key file: #{text.lines.count} lines, mode #{format('%o', File.stat(path).mode & 0o777)}, PEM markers #{pem ? 'present' : 'MISSING'}"
puts "literal \\n in the file: the secret was pasted on one line" if text.include?('\n')
asc = begin
  Asc.new(path, kid, issuer)
rescue OpenSSL::PKey::PKeyError => e
  abort "the key file is not a private key OpenSSL can read: #{e.class}"
rescue RuntimeError => e
  abort e.message
end
puts "public key SHA-256: #{asc.public_sha256}"

failed = false
# Apps reads with any role; bundle IDs only with one that may manage signing.
["/v1/apps?filter[bundleId]=dev.starbridge.ios&fields[apps]=bundleId",
 "/v1/bundleIds?filter[identifier]=dev.starbridge.ios&fields[bundleIds]=identifier&limit=5"].each do |q|
  code, body = asc.request("GET", q)
  errors = Asc.errors(body)
  ids = (body["data"] || []).map { |d| d.dig("attributes", "bundleId") || d.dig("attributes", "identifier") }.inspect
  puts "GET #{q.split('?').first}: #{code} #{errors.empty? ? ids : errors}#{asc.skew ? " (runner clock #{asc.skew}s off Apple's)" : ''}"
  failed ||= code != 200
end
exit 1 if failed
# What signing starts from: each App ID and its capabilities.
code, body = asc.request("GET", "/v1/bundleIds?filter[identifier]=dev.starbridge.ios,dev.starbridge.ios.notifications" \
                                "&include=bundleIdCapabilities&fields[bundleIdCapabilities]=capabilityType&limit=10")
if code == 200
  types = (body["included"] || []).map { |c| [c["id"], c.dig("attributes", "capabilityType")] }.to_h
  (body["data"] || []).each do |d|
    caps = (d.dig("relationships", "bundleIdCapabilities", "data") || []).map { |c| types[c["id"]] }.compact.sort
    puts "App ID #{d.dig('attributes', 'identifier')}: #{caps.join(', ')}"
  end
end
