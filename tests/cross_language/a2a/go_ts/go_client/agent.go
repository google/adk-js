/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/remoteagent"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/genai"
)

func main() {
	var agentURL string
	var agentInput string

	flag.StringVar(&agentURL, "agent_url", "", "URL of the agent")
	flag.StringVar(&agentInput, "agent_input", "Hello Go Agent From TS!", "Input for the agent")
	flag.Parse()

	if agentURL == "" {
		log.Fatalf("agent_url flag is required")
	}

	ctx := context.Background()

	// Create a remote A2A agent pointing to our TS server
	a, err := remoteagent.NewA2A(remoteagent.A2AConfig{
		Name:            "ts_test_agent",
		AgentCardSource: agentURL,
	})
	if err != nil {
		log.Fatalf("Failed to create remote A2A agent: %v", err)
	}

	inMemorySvc := session.InMemoryService()
	// Create a runner config
	runnerConfig := runner.Config{
		AppName:        "test-go-client",
		Agent:          a,
		SessionService: inMemorySvc,
	}

	r, err := runner.New(runnerConfig)
	if err != nil {
		log.Fatalf("Failed to create runner: %v", err)
	}

	_, err = inMemorySvc.Create(ctx, &session.CreateRequest{
		AppName:   "test-go-client",
		SessionID: "session-1",
		UserID:    "user-1",
	})
	if err != nil {
		log.Fatalf("Failed to create session: %v", err)
	}

	// Prepare user input
	content := &genai.Content{
		Role: "user",
		Parts: []*genai.Part{
			{Text: agentInput},
		},
	}
	// Run the agent
	eventStream := r.Run(ctx, "user-1", "session-1", content, agent.RunConfig{})

	en := json.NewEncoder(os.Stdout)
	for event, err := range eventStream {
		if err != nil {
			log.Fatalf("Stream error: %v", err)
		}

		if err := en.Encode(FromSessionEvent(*event)); err != nil {
			log.Fatalf("Failed to marshal event: %v", err)
		}
		os.Stdout.Sync()
	}
}
