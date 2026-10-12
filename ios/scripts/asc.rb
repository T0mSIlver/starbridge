# App Store Connect's REST API, signed in with an API key (.p8): a token per client, valid 10
# minutes, made afresh when it nears its end. Never prints the key or the token.
require "base64"
require "json"
require "net/http"
require "openssl"
require "time"

class Asc
  attr_reader :key, :skew

  def initialize(path, kid, issuer)
    @key = OpenSSL::PKey.read(File.read(path))
    raise "the key is #{@key.class}, not an EC key" unless @key.is_a?(OpenSSL::PKey::EC)
    @kid = kid
    @issuer = issuer
    @http = Net::HTTP.new("api.appstoreconnect.apple.com", 443)
    @http.use_ssl = true
  end

  # The public half's SHA-256, to compare with the .p8 kept offline.
  def public_sha256
    spki = if @key.respond_to?(:public_to_der) then @key.public_to_der
           else
             pub = OpenSSL::PKey::EC.new(@key.group)
             pub.public_key = @key.public_key
             pub.to_der
           end
    OpenSSL::Digest::SHA256.hexdigest(spki)
  end

  # Returns [status, parsed body]; the body is {} when it is empty or not JSON.
  def request(method, path, body = nil)
    req = { "GET" => Net::HTTP::Get, "POST" => Net::HTTP::Post, "PATCH" => Net::HTTP::Patch,
            "DELETE" => Net::HTTP::Delete }.fetch(method).new(path)
    req["Authorization"] = "Bearer #{token}"
    if body
      req["Content-Type"] = "application/json"
      req.body = body.to_json
    end
    res = @http.start { |h| h.request(req) }
    @skew = Time.now.to_i - Time.httpdate(res["date"]).to_i if res["date"]
    [res.code.to_i, (JSON.parse(res.body) rescue {})]
  end

  def self.errors(body)
    (body["errors"] || []).map { |e| "#{e['code']}: #{e['detail']}" }.join("; ")
  end

  private

  def token
    now = Time.now.to_i
    return @token if @token && now < @expires - 60
    @expires = now + 600
    b64 = ->(s) { Base64.urlsafe_encode64(s).delete("=") }
    input = [b64.call({ alg: "ES256", kid: @kid, typ: "JWT" }.to_json),
             b64.call({ iss: @issuer, iat: now, exp: @expires, aud: "appstoreconnect-v1" }.to_json)].join(".")
    # JWS wants r and s, 32 bytes each, where OpenSSL gives a DER sequence.
    der = @key.sign(OpenSSL::Digest::SHA256.new, input)
    raw = OpenSSL::ASN1.decode(der).value.map { |n| n.value.to_s(2).rjust(32, "\0") }.join
    @token = "#{input}.#{b64.call(raw)}"
  end
end
