package main

import (
	"iter"
	"net/http"
	"net/url"

	"github.com/a2aproject/a2a-go/a2a"
	"github.com/a2aproject/a2a-go/a2asrv"
	"google.golang.org/genai"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/server/adka2a"
	"google.golang.org/adk/session"
)

func mountHitlAgent(mux *http.ServeMux, baseURL *url.URL) error {
	a, err := agent.New(agent.Config{
		Name:        "mock_hitl_agent",
		Description: "A mock hitl agent",
		Run: func(ctx agent.InvocationContext) iter.Seq2[*session.Event, error] {
			return func(yield func(*session.Event, error) bool) {
				event := session.NewEvent(ctx.InvocationID())
				event.Author = "mock_hitl_agent"
				event.LLMResponse = model.LLMResponse{
					Content: &genai.Content{
						Role: genai.RoleModel,
						Parts: []*genai.Part{
							{Text: "need to request approval first!"},
							{FunctionCall: &genai.FunctionCall{
								Name: "request_approval",
								Args: map[string]any{},
								ID:   "call-123",
							}},
						},
					},
				}
				event.LongRunningToolIDs = []string{"call-123"}
				
				yield(event, nil)
			}
		},
	})
	if err != nil {
		return err
	}

	hitlPath := "/invoke-hitl"
	hitlAgentCard := &a2a.AgentCard{
		Name:               a.Name(),
		Skills:             adka2a.BuildAgentSkills(a),
		PreferredTransport: a2a.TransportProtocolJSONRPC,
		URL:                baseURL.JoinPath("/a2a/hitl_agent", hitlPath).String(),
		Capabilities:       a2a.AgentCapabilities{Streaming: false},
	}
	mux.Handle("/a2a/hitl_agent"+a2asrv.WellKnownAgentCardPath, a2asrv.NewStaticAgentCardHandler(hitlAgentCard))

	executor := adka2a.NewExecutor(adka2a.ExecutorConfig{
		RunnerConfig: runner.Config{
			AppName:        "test-app",
			Agent:          a,
			SessionService: session.InMemoryService(),
		},
	})
	requestHandler := a2asrv.NewHandler(executor)
	mux.Handle("/a2a/hitl_agent"+hitlPath, a2asrv.NewJSONRPCHandler(requestHandler))

	return nil
}
