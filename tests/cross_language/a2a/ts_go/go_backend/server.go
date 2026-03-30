/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
)

func main() {
	fmt.Println("Starting Go server...")
	portStr := os.Getenv("PORT")
	if portStr == "" {
		portStr = "0"
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%s", portStr))
	if err != nil {
		log.Fatalf("Failed to bind to a port: %v", err)
	}

	baseURL := &url.URL{Scheme: "http", Host: listener.Addr().String()}
	mux := http.NewServeMux()

	err = mountBasicAgent(mux, baseURL)
	if err != nil {
		log.Fatalf("Failed to mount basic agent: %v", err)
	}
	err = mountHitlAgent(mux, baseURL)
	if err != nil {
		log.Fatalf("Failed to mount hitl agent: %v", err)
	}

	fmt.Printf("A2A Server started on http://%s\n", listener.Addr().String())
	os.Stdout.Sync()

	err = http.Serve(listener, mux)
	if err != nil && err != http.ErrServerClosed {
		log.Fatalf("HTTP Serve error: %v", err)
	}
}
