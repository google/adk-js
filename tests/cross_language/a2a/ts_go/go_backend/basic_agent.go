package main

import (
	"context"
	"iter"
	"net/http"
	"net/url"

	"github.com/a2aproject/a2a-go/a2a"
	"github.com/a2aproject/a2a-go/a2asrv"
	"google.golang.org/genai"

	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/server/adka2a"
	"google.golang.org/adk/session"
)

// mockModel implements the google.golang.org/adk/model.LLM interface.
// It bypasses the need for an external API key and returns a static LLM-style token stream.
type mockModel struct{}

func (m *mockModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		resp := &model.LLMResponse{
			Content: &genai.Content{
				Role: genai.RoleModel,
				Parts: []*genai.Part{
					{Text: "Hello from Go test agent"},
				},
			},
		}
		yield(resp, nil)
	}
}

func (m *mockModel) Name() string { return "mock" }

var _ model.LLM = (*mockModel)(nil)

func mountBasicAgent(mux *http.ServeMux, baseURL *url.URL) error {
	a, err := llmagent.New(llmagent.Config{
		Name:        "go_test_agent",
		Model:       &mockModel{},
		Description: "A simple go echo agent for integration tests",
		Instruction: "You represent a simple mock agent.",
	})
	if err != nil {
		return err
	}

	agentPath := "/invoke"
	agentCard := &a2a.AgentCard{
		Name:               a.Name(),
		Skills:             adka2a.BuildAgentSkills(a),
		PreferredTransport: a2a.TransportProtocolJSONRPC,
		URL:                baseURL.JoinPath("/a2a/basic_agent", agentPath).String(),
		Capabilities:       a2a.AgentCapabilities{Streaming: true},
	}

	mux.Handle("/a2a/basic_agent"+a2asrv.WellKnownAgentCardPath, a2asrv.NewStaticAgentCardHandler(agentCard))

	executor := adka2a.NewExecutor(adka2a.ExecutorConfig{
		RunnerConfig: runner.Config{
			AppName:        "test-app",
			Agent:          a,
			SessionService: session.InMemoryService(),
		},
	})
	requestHandler := a2asrv.NewHandler(executor)
	mux.Handle("/a2a/basic_agent"+agentPath, a2asrv.NewJSONRPCHandler(requestHandler))

	return nil
}
