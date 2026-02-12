import { STALE_HOURS_THRESHOLD } from "./settings";
import axios, { AxiosInstance, AxiosError } from "axios";
import axiosRetry from "axios-retry";
import { GITHUB_TOKEN } from "./settings";

export class RequestException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestException";
  }
}

// API Call Counter & Utilities
let _apiCallCount = 0;

//Returns the total number of API calls made since the last reset.
export function getApiCallCount(): number {
  return _apiCallCount;
}

// Resets the global API call counter to zero.
export function resetApiCallCount(): void {
  _apiCallCount = 0;
}

// Increments the global API call counter.

// Needed if agent or tools run concurrently.
export function incrementApiCallCount(): void {
  _apiCallCount += 1;
}

const logger = console;

const httpClient: AxiosInstance = axios.create({
  timeout: 60_000, // 60 seconds
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  },
});

/* ----------------------------------
 * Retry Strategy (Exponential Backoff)
 * ---------------------------------- */

axiosRetry(httpClient, {
  retries: 6,
  retryDelay: axiosRetry.exponentialDelay, 
  retryCondition: (error: AxiosError) => {
    const status = error.response?.status;
    return (
      status !== undefined &&
      [429, 500, 502, 503, 504].includes(status)
    );
  },
});

export async function getRequest<T = any>(
  url: string,
  params?: Record<string, any>
): Promise<T> {
  incrementApiCallCount();
  try {
    const response = await httpClient.get<T>(url, { params });
    return response.data;
  } catch (error) {
    console.error(`GET request failed for ${url}:`, error);
    throw error;
  }
}

export async function postRequest<T = any>(
  url: string,
  payload: any
): Promise<T> {
  incrementApiCallCount();
  try {
    const response = await httpClient.post<T>(url, payload);
    return response.data;
  } catch (error) {
    console.error(`POST request failed for ${url}:`, error);
    throw error;
  }
}

export async function patchRequest<T = any>(
  url: string,
  payload: any
): Promise<T> {
  incrementApiCallCount();
  try {
    const response = await httpClient.patch<T>(url, payload);
    return response.data;
  } catch (error) {
    console.error(`PATCH request failed for ${url}:`, error);
    throw error;
  }
}

export async function deleteRequest<T = any>(
  url: string
): Promise<T | { status: string; message: string }> {
  incrementApiCallCount();
  try {
    const response = await httpClient.delete(url);

    if (response.status === 204) {
      return {
        status: "success",
        message: "Deletion successful.",
      };
    }

    return response.data as T;
  } catch (error) {
    console.error(`DELETE request failed for ${url}:`, error);
    throw error;
  }
}

export function errorResponse(errorMessage: string): {
  status: string;
  message: string;
} {
  return {
    status: "error",
    message: errorMessage,
  };
}

/**
 * Finds open issues older than the specified threshold using server-side filtering.
 *
 * OPTIMIZATION:
 * Uses the GitHub Search API `created:<DATE` syntax instead of client-side filtering.
 *
 * @param owner Repository owner
 * @param repo Repository name
 * @param daysOld Filter issues older than this many days.
 *                Defaults to STALE_HOURS_THRESHOLD / 24.
 * @returns A list of issue numbers matching the criteria.
 */
export async function getOldOpenIssueNumbers(
  owner: string,
  repo: string,
  daysOld?: number
): Promise<number[]> {
  if (daysOld == null) {
    daysOld = STALE_HOURS_THRESHOLD / 24;
  }

  const nowUtc = new Date();
  const cutoffMs = daysOld * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(nowUtc.getTime() - cutoffMs);

  const cutoffStr = cutoffDate.toISOString().replace(/\.\d{3}Z$/, "Z");

  const query = `repo:${owner}/${repo} is:issue state:open created:<${cutoffStr}`;

  console.log(
    `Searching for issues in '${owner}/${repo}' created before ${cutoffStr}...`
  );

  const issueNumbers: number[] = [];
  let page = 1;
  const url = "https://api.github.com/search/issues";

  while (true) {
    try {
      const params = {
        q: query,
        per_page: 100,
        page,
      };

      const data = await getRequest(url, params );
      const items = data.items ?? [];

      if (items.length === 0) {
        break;
      }

      for (const item of items) {
        // Exclude pull requests (GitHub search returns PRs as issues)
        if (!("pull_request" in item)) {
          issueNumbers.push(item.number);
        }
      }

      if (items.length < 100) {
        break;
      }

      page += 1;
    } catch (error) {
      console.error(`GitHub search failed on page ${page}: ${error}`);
      break;
    }
  }

  console.log(`Found ${issueNumbers.length} stale issues.`);
  return issueNumbers;
}
