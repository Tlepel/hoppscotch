import * as E from "fp-ts/Either"
import { md5 } from "js-md5"

import { getService } from "~/modules/dioc"
import { getI18n } from "~/modules/i18n"
import { InterceptorService } from "~/services/interceptor.service"

export interface DigestAuthParams {
  username: string
  password: string
  realm: string
  nonce: string
  endpoint: string
  method: string
  algorithm: string
  qop: string
  nc?: string
  opaque?: string
  cnonce?: string // client nonce (optional but typically required in qop='auth')
}

// Function to generate Digest Auth Header
export async function generateDigestAuthHeader(params: DigestAuthParams) {
  const {
    username,
    password,
    realm,
    nonce,
    endpoint,
    method,
    algorithm = "MD5",
    qop,
    nc = "00000001",
    opaque,
    cnonce,
  } = params

  const uri = endpoint.replace(/(^\w+:|^)\/\//, "")

  // Generate client nonce if not provided
  const generatedCnonce = cnonce || md5(`${Math.random()}`)

  // Step 1: Hash the username, realm, and password
  const ha1 = md5(`${username}:${realm}:${password}`)

  // Step 2: Hash the method and URI
  const ha2 = md5(`${method}:${uri}`)

  // Step 3: Compute the response hash
  const response = md5(`${ha1}:${nonce}:${nc}:${generatedCnonce}:${qop}:${ha2}`)

  // Build the Digest header
  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm="${algorithm}", response="${response}", qop=${qop}, nc=${nc}, cnonce="${generatedCnonce}"`

  if (opaque) {
    authHeader += `, opaque="${opaque}"`
  }

  return authHeader
}

export interface DigestAuthInfo {
  realm: string
  nonce: string
  qop: string
  opaque?: string
  algorithm: string
}

export async function fetchInitialDigestAuthInfo(
  url: string,
  method: string,
  disableRetry: boolean
): Promise<DigestAuthInfo> {
  const t = getI18n()

  try {
    const service = getService(InterceptorService)
    const initialResponse = await service.runRequest({
      url,
      method,
    }).response

    if (E.isLeft(initialResponse)) {
      const initialFetchFailureReason =
        initialResponse.left === "cancellation"
          ? initialResponse.left
          : initialResponse.left.humanMessage.heading(t)

      throw new Error(initialFetchFailureReason)
    }

    // Check if the response status is 401 (which is expected in Digest Auth flow)
    if (initialResponse.right.status === 401 && !disableRetry) {
      const authHeader = initialResponse.right.headers["www-authenticate"]

      if (authHeader) {
        const authParams = parseDigestAuthHeader(authHeader)
        if (
          authParams &&
          authParams.realm &&
          authParams.nonce &&
          authParams.qop
        ) {
          return {
            realm: authParams.realm,
            nonce: authParams.nonce,
            qop: authParams.qop,
            opaque: authParams.opaque,
            algorithm: authParams.algorithm,
          }
        }
      }
      throw new Error(
        "Failed to parse authentication parameters from WWW-Authenticate header"
      )
    } else if (initialResponse.right.status === 401 && disableRetry) {
      throw new Error(
        `401 Unauthorized received. Retry is disabled as specified, so no further attempts will be made.`
      )
    } else {
      throw new Error(`Unexpected response: ${initialResponse.right.status}`)
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : error

    console.error(`Failed to fetch initial Digest Auth info: ${errMsg}`)

    throw error // Re-throw the error to handle it further up the chain if needed
  }
}

// Utility function to parse Digest auth header values
function parseDigestAuthHeader(
  header: string
): { [key: string]: string } | null {
  const matches = header.match(/([a-z0-9]+)="([^"]+)"/gi)
  if (!matches) return null

  const authParams: { [key: string]: string } = {}
  matches.forEach((match) => {
    const parts = match.split("=")
    authParams[parts[0]] = parts[1].replace(/"/g, "")
  })

  return authParams
}