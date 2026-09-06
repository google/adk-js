/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python
 * contributing/samples/context_management/cache_analysis.
 *
 * Cache Analysis Research Assistant Agent.
 *
 * Ported as literally as the two APIs allow: same agent name, the same 4k+
 * token description and instruction verbatim, the same seven tools with the
 * same names, parameter names, full docstring descriptions and return shapes.
 * The instruction and the tool declarations are what push the prompt over the
 * cache threshold, so they are copied character for character.
 *
 * What could NOT be ported is the thing the sample exists to demonstrate:
 * `App(context_cache_config=ContextCacheConfig(min_tokens=..., ttl_seconds=...,
 * cache_intervals=...))`. adk-js `AppOptions` is only
 * `{name, rootAgent, plugins, resumabilityConfig}` — there is no
 * `ContextCacheConfig` type anywhere in `@google/adk`, no explicit
 * `cachedContent` plumbing on `LlmRequest`, and `LlmResponse.usageMetadata`
 * is never inspected for `cachedContentTokenCount`.
 *
 * With the cache config gone the sample's `App` would hold nothing but the
 * agent, and the Python side runs the bare agent too (the sample exports both
 * `app` and `root_agent`, and `_parity.load_sample` resolves `root_agent`
 * first). So this file exports the agent alone, and both runtimes compare the
 * same uncached agent rather than an App on one side only.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** `time.sleep(...)` in the Python sample; kept so the shapes match. */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** `random.randint(a, b)` — inclusive on both ends. */
function randInt(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a + 1));
}

/** `random.uniform(a, b)`. */
function randUniform(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** `random.choice(seq)`. */
function randChoice<T>(seq: readonly T[]): T {
  return seq[Math.floor(Math.random() * seq.length)];
}

/** `random.sample(seq, k)` — k distinct elements, in random order. */
function randSample<T>(seq: readonly T[], k: number): T[] {
  const pool = [...seq];
  const picked: T[] = [];
  for (let i = 0; i < k && pool.length > 0; i++) {
    picked.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
  }
  return picked;
}

const analyzeDataPatterns = new FunctionTool({
  name: 'analyze_data_patterns',
  description: `Analyze data patterns and provide insights.

This tool performs comprehensive data analysis including statistical analysis,
trend identification, anomaly detection, correlation analysis, and predictive
modeling. It can handle various data formats including CSV, JSON, XML, and
plain text data structures.

Args:
    data: The input data to analyze. Can be structured (JSON, CSV) or
          unstructured text data. For structured data, include column headers
          and ensure proper formatting. For time series data, include
          timestamps in ISO format.
    analysis_type: Type of analysis to perform. Options include:
                  - "comprehensive": Full statistical and trend analysis
                  - "statistical": Basic statistical measures only
                  - "trends": Time series and trend analysis
                  - "anomalies": Outlier and anomaly detection
                  - "correlations": Correlation and relationship analysis
                  - "predictive": Forecasting and prediction models

Returns:
    Dictionary containing analysis results with the following structure:
    {
        "summary": "High-level summary of findings",
        "statistics": {...},  # Statistical measures
        "trends": {...},      # Trend analysis results
        "anomalies": [...],   # List of detected anomalies
        "correlations": {...}, # Correlation matrix and relationships
        "predictions": {...}, # Forecasting results if applicable
        "recommendations": [...] # Actionable insights and recommendations
    }`,
  parameters: z.object({
    data: z.string(),
    analysis_type: z.string().default('comprehensive'),
  }),
  execute: async ({data, analysis_type: analysisType}) => {
    // Simulate analysis processing time
    await sleep(0.1);

    return {
      summary: `Analyzed ${data.length} characters of ${analysisType} data`,
      statistics: {
        data_points: data.trim() === '' ? 0 : data.trim().split(/\s+/).length,
        analysis_type: analysisType,
        processing_time: '0.1 seconds',
      },
      recommendations: [
        'Continue monitoring data trends',
        'Consider additional data sources for correlation analysis',
      ],
    };
  },
});

const researchLiterature = new FunctionTool({
  name: 'research_literature',
  description: `Research academic and professional literature on specified topics.

This tool performs comprehensive literature research across multiple academic
databases, professional journals, conference proceedings, and industry reports.
It can analyze research trends, identify key authors and institutions, extract
methodological approaches, and synthesize findings across multiple sources.

The tool supports various research methodologies including systematic reviews,
meta-analyses, bibliometric analysis, and citation network analysis. It can
identify research gaps, emerging trends, and future research directions in
the specified field of study.

Args:
    topic: The research topic or query. Can be specific (e.g., "context caching
           in large language models") or broad (e.g., "machine learning optimization").
           Use specific keywords and phrases for better results. Boolean operators
           (AND, OR, NOT) are supported for complex queries.
    sources: List of preferred sources to search. Options include:
            - "academic": Peer-reviewed academic journals and papers
            - "conference": Conference proceedings and presentations
            - "industry": Industry reports and white papers
            - "patents": Patent databases and intellectual property
            - "preprints": ArXiv, bioRxiv and other preprint servers
            - "books": Academic and professional books
    depth: Research depth level:
           - "comprehensive": Full literature review with detailed analysis
           - "focused": Targeted search on specific aspects
           - "overview": High-level survey of the field
           - "technical": Deep technical implementation details
    time_range: Time range for literature search:
               - "recent": Last 2 years
               - "current": Last 5 years
               - "historical": All available time periods
               - "decade": Last 10 years

Returns:
    Dictionary containing research results:
    {
        "summary": "Executive summary of findings",
        "key_papers": [...],      # Most relevant papers found
        "authors": [...],         # Key researchers in the field
        "institutions": [...],    # Leading research institutions
        "trends": {...},          # Research trends and evolution
        "methodologies": [...],   # Common research approaches
        "gaps": [...],            # Identified research gaps
        "citations": {...},       # Citation network analysis
        "recommendations": [...]  # Future research directions
    }`,
  parameters: z.object({
    topic: z.string(),
    sources: z.array(z.string()).optional(),
    depth: z.string().default('comprehensive'),
    time_range: z.string().default('recent'),
  }),
  execute: async ({topic, depth}) => {
    // Simulate research processing
    await sleep(0.2);

    return {
      summary: `Conducted ${depth} literature research on '${topic}'`,
      key_papers: [
        `Recent advances in ${topic.toLowerCase()}: A systematic review`,
        `Methodological approaches to ${topic.toLowerCase()} optimization`,
        `Future directions in ${topic.toLowerCase()} research`,
      ],
      trends: {
        emerging_topics: [`${topic} optimization`, `${topic} scalability`],
        methodology_trends: ['experimental validation', 'theoretical analysis'],
      },
      recommendations: [
        `Focus on practical applications of ${topic}`,
        'Consider interdisciplinary approaches',
        'Investigate scalability challenges',
      ],
    };
  },
});

const generateTestScenarios = new FunctionTool({
  name: 'generate_test_scenarios',
  description: `Generate comprehensive test scenarios for system validation.

This tool creates detailed test scenarios, test cases, and validation protocols
for various types of systems including software applications, AI models,
distributed systems, and hardware components. It supports multiple testing
methodologies including unit testing, integration testing, performance testing,
security testing, and user acceptance testing.

The tool can generate both positive and negative test cases, edge cases,
boundary conditions, stress tests, and failure scenarios. It incorporates
industry best practices and testing frameworks to ensure comprehensive
coverage and reliable validation results.

Args:
    system_type: Type of system to test. Supported types include:
                - "software": Software applications and services
                - "ai_model": Machine learning and AI model testing
                - "distributed": Distributed systems and microservices
                - "database": Database systems and data integrity
                - "api": API endpoints and web services
                - "hardware": Hardware components and embedded systems
                - "security": Security systems and protocols
    complexity: Test complexity level:
               - "basic": Essential functionality tests only
               - "medium": Standard test suite with common scenarios
               - "advanced": Comprehensive testing with edge cases
               - "expert": Exhaustive testing with stress and chaos scenarios
    coverage: List of testing areas to cover:
             - "functionality": Core feature testing
             - "performance": Speed, throughput, and scalability
             - "security": Authentication, authorization, data protection
             - "usability": User experience and interface testing
             - "compatibility": Cross-platform and integration testing
             - "reliability": Fault tolerance and recovery testing
    constraints: Testing constraints and requirements:
                {
                    "time_limit": "Maximum testing duration",
                    "resources": "Available testing resources",
                    "environment": "Testing environment specifications",
                    "compliance": "Regulatory or standard requirements"
                }

Returns:
    Dictionary containing generated test scenarios:
    {
        "overview": "Test plan summary and objectives",
        "scenarios": [...],        # Detailed test scenarios
        "test_cases": [...],       # Individual test cases
        "edge_cases": [...],       # Boundary and edge conditions
        "performance_tests": [...], # Performance validation tests
        "security_tests": [...],   # Security and vulnerability tests
        "automation": {...},       # Test automation recommendations
        "metrics": {...},          # Success criteria and metrics
        "schedule": {...}          # Recommended testing timeline
    }`,
  parameters: z.object({
    system_type: z.string(),
    complexity: z.string().default('medium'),
    coverage: z.array(z.string()).optional(),
    constraints: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async ({system_type: systemType, complexity, coverage}) => {
    const cover = coverage ?? ['functionality', 'performance', 'security'];

    // Simulate test generation
    await sleep(0.15);

    const numScenarios =
      (
        {basic: 5, medium: 10, advanced: 20, expert: 35} as Record<
          string,
          number
        >
      )[complexity] ?? 10;

    return {
      overview: `Generated ${numScenarios} test scenarios for ${systemType} system`,
      scenarios: Array.from(
        {length: numScenarios},
        (_unused, i) =>
          `Test scenario ${i + 1}:` +
          ` ${systemType} ${cover[i % cover.length]} validation`,
      ),
      test_cases: [
        `Verify ${systemType} handles normal operations`,
        `Test ${systemType} error handling and recovery`,
        `Validate ${systemType} performance under load`,
      ],
      metrics: {
        // `complexity.index(complexity)` is always 0 in Python; kept verbatim.
        coverage_target: `${75 + complexity.indexOf(complexity) * 5}%`,
        success_criteria: 'All critical tests pass',
        performance_benchmark: `${systemType} specific benchmarks`,
      },
    };
  },
});

const optimizeSystemPerformance = new FunctionTool({
  name: 'optimize_system_performance',
  description: `Analyze system performance and provide detailed optimization recommendations.

This tool performs comprehensive system performance analysis including bottleneck
identification, resource utilization assessment, scalability planning, and provides
specific optimization strategies tailored to the system type and constraints.

Args:
    system_type: Type of system to optimize:
                - "web_application": Frontend and backend web services
                - "database": Relational, NoSQL, or distributed databases
                - "ml_pipeline": Machine learning training and inference systems
                - "distributed_cache": Caching layers and distributed memory systems
                - "microservices": Service-oriented architectures
                - "data_processing": ETL, stream processing, batch systems
                - "api_gateway": Request routing and API management systems
    current_metrics: Current performance metrics including:
                    {
                        "response_time_p95": "95th percentile response time in ms",
                        "throughput_rps": "Requests per second",
                        "cpu_utilization": "Average CPU usage percentage",
                        "memory_usage": "Memory consumption in GB",
                        "error_rate": "Error percentage",
                        "availability": "System uptime percentage"
                    }
    target_improvements: Desired performance targets:
                        {
                            "response_time_improvement": "Target reduction in response time",
                            "throughput_increase": "Desired increase in throughput",
                            "cost_reduction": "Target cost optimization percentage",
                            "availability_target": "Desired uptime percentage"
                        }
    constraints: Operational constraints:
                {
                    "budget_limit": "Maximum budget for improvements",
                    "timeline": "Implementation timeline constraints",
                    "technology_restrictions": "Required or forbidden technologies",
                    "compliance_requirements": "Security/regulatory constraints"
                }

Returns:
    Comprehensive optimization analysis:
    {
        "performance_analysis": {
            "bottlenecks_identified": ["Critical performance bottlenecks"],
            "root_cause_analysis": "Detailed analysis of performance issues",
            "current_vs_target": "Gap analysis between current and target metrics"
        },
        "optimization_recommendations": {
            "infrastructure_changes": ["Hardware/cloud resource recommendations"],
            "architecture_improvements": ["System design optimizations"],
            "code_optimizations": ["Software-level improvements"],
            "configuration_tuning": ["Parameter and setting adjustments"]
        },
        "implementation_roadmap": {
            "phase_1_quick_wins": ["Immediate improvements (0-2 weeks)"],
            "phase_2_medium_term": ["Medium-term optimizations (1-3 months)"],
            "phase_3_strategic": ["Long-term architectural changes (3-12 months)"]
        },
        "expected_outcomes": {
            "performance_improvements": "Projected performance gains",
            "cost_implications": "Expected costs and savings",
            "risk_assessment": "Implementation risks and mitigation strategies"
        }
    }`,
  parameters: z.object({
    system_type: z.string(),
    current_metrics: z.record(z.string(), z.unknown()),
    target_improvements: z.record(z.string(), z.unknown()),
    constraints: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: ({system_type: systemType}) => {
    // Simulate comprehensive performance optimization analysis
    const optimizationAreas = [
      'Database query optimization',
      'Caching layer enhancement',
      'Load balancing improvements',
      'Resource scaling strategies',
      'Code-level optimizations',
      'Infrastructure upgrades',
    ];

    return {
      system_analyzed: systemType,
      optimization_areas: randSample(
        optimizationAreas,
        Math.min(4, optimizationAreas.length),
      ),
      performance_score: randInt(65, 95),
      implementation_complexity: randChoice(['Low', 'Medium', 'High']),
      estimated_improvement: `${randInt(15, 45)}%`,
      recommendations: [
        'Implement distributed caching for frequently accessed data',
        'Optimize database queries and add strategic indexes',
        'Configure auto-scaling based on traffic patterns',
        'Implement asynchronous processing for heavy operations',
      ],
    };
  },
});

const analyzeSecurityVulnerabilities = new FunctionTool({
  name: 'analyze_security_vulnerabilities',
  description: `Perform comprehensive security vulnerability analysis and risk assessment.

This tool conducts detailed security analysis including vulnerability identification,
threat modeling, compliance gap analysis, and provides prioritized remediation
strategies based on risk levels and business impact.

Args:
    system_components: List of system components to analyze:
                      - "web_frontend": User interfaces, SPAs, mobile apps
                      - "api_endpoints": REST/GraphQL APIs, microservices
                      - "database_layer": Data storage and access systems
                      - "authentication": User auth, SSO, identity management
                      - "data_processing": ETL, analytics, ML pipelines
                      - "infrastructure": Servers, containers, cloud services
                      - "network_layer": Load balancers, firewalls, CDNs
    security_scope: Analysis depth:
                   - "basic": Standard vulnerability scanning
                   - "comprehensive": Full security assessment
                   - "compliance_focused": Regulatory compliance analysis
                   - "threat_modeling": Advanced threat analysis
    compliance_frameworks: Required compliance standards:
                          ["SOC2", "GDPR", "HIPAA", "PCI-DSS", "ISO27001"]
    threat_model: Threat landscape consideration:
                 - "startup": Basic threat model for early-stage companies
                 - "enterprise": Corporate threat landscape
                 - "high_security": Government/financial sector threats
                 - "public_facing": Internet-exposed systems

Returns:
    Security analysis results:
    {
        "vulnerability_assessment": {
            "critical_vulnerabilities": ["High-priority security issues"],
            "moderate_risks": ["Medium-priority concerns"],
            "informational": ["Low-priority observations"],
            "risk_score": "Overall security risk rating (1-10)"
        },
        "threat_analysis": {
            "attack_vectors": ["Potential attack methods"],
            "threat_actors": ["Relevant threat actor profiles"],
            "attack_likelihood": "Probability assessment",
            "potential_impact": "Business impact analysis"
        },
        "compliance_status": {
            "framework_compliance": "Compliance percentage per framework",
            "gaps_identified": ["Non-compliant areas"],
            "certification_readiness": "Readiness for compliance audits"
        },
        "remediation_plan": {
            "immediate_actions": ["Critical fixes (0-2 weeks)"],
            "short_term_improvements": ["Important fixes (1-2 months)"],
            "strategic_initiatives": ["Long-term security enhancements"],
            "resource_requirements": "Personnel and budget needs"
        }
    }`,
  parameters: z.object({
    system_components: z.array(z.string()),
    security_scope: z.string().default('comprehensive'),
    compliance_frameworks: z.array(z.string()).optional(),
    threat_model: z.string().default('enterprise'),
  }),
  execute: ({system_components: systemComponents}) => {
    return {
      components_analyzed: systemComponents.length,
      critical_vulnerabilities: randInt(0, 3),
      moderate_risks: randInt(2, 8),
      overall_security_score: randInt(6, 9),
      compliance_percentage: randInt(75, 95),
      top_recommendations: [
        'Implement input validation and parameterized queries',
        'Enable comprehensive security logging and monitoring',
        'Review and update authentication and authorization controls',
        'Conduct regular security training for development team',
      ],
    };
  },
});

const designScalabilityArchitecture = new FunctionTool({
  name: 'design_scalability_architecture',
  description: `Design comprehensive scalability architecture for anticipated growth.

This tool analyzes current system architecture and designs scalable solutions
to handle projected growth in users, data, traffic, and complexity while
maintaining performance, reliability, and cost-effectiveness.

Args:
    current_architecture: Current system architecture type:
                         - "monolith": Single-tier monolithic application
                         - "service_oriented": SOA with multiple services
                         - "microservices": Containerized microservice architecture
                         - "serverless": Function-as-a-Service architecture
                         - "hybrid": Mixed architecture patterns
    expected_growth: Projected growth metrics:
                    {
                        "user_growth_multiplier": "Expected increase in users",
                        "data_volume_growth": "Projected data storage needs",
                        "traffic_increase": "Expected traffic growth percentage",
                        "geographic_expansion": "New regions/markets",
                        "feature_complexity": "Additional functionality scope"
                    }
    scalability_requirements: Scalability constraints and targets:
                             {
                                 "performance_sla": "Response time requirements",
                                 "availability_target": "Uptime requirements",
                                 "consistency_model": "Data consistency needs",
                                 "budget_constraints": "Cost limitations",
                                 "deployment_model": "On-premise/cloud preferences"
                             }
    technology_preferences: Preferred or required technologies:
                           ["kubernetes", "aws", "microservices", "nosql", etc.]

Returns:
    Scalability architecture design:
    {
        "architecture_recommendation": {
            "target_architecture": "Recommended architecture pattern",
            "migration_strategy": "Path from current to target architecture",
            "technology_stack": "Recommended technologies and frameworks"
        },
        "scalability_patterns": {
            "horizontal_scaling": "Auto-scaling and load distribution strategies",
            "data_partitioning": "Database sharding and data distribution",
            "caching_strategy": "Multi-level caching implementation",
            "async_processing": "Background job and queue systems"
        },
        "infrastructure_design": {
            "compute_resources": "Server/container resource planning",
            "data_storage": "Database and storage architecture",
            "network_topology": "CDN, load balancing, and routing",
            "monitoring_observability": "Logging, metrics, and alerting"
        },
        "implementation_phases": {
            "foundation_setup": "Core infrastructure preparation",
            "service_decomposition": "Breaking down monolithic components",
            "data_migration": "Database and storage transitions",
            "traffic_migration": "Gradual user traffic transition"
        }
    }`,
  parameters: z.object({
    current_architecture: z.string(),
    expected_growth: z.record(z.string(), z.unknown()),
    scalability_requirements: z.record(z.string(), z.unknown()),
    technology_preferences: z.array(z.string()).optional(),
  }),
  execute: () => {
    // Simulate scalability architecture design
    const architecturePatterns = [
      'Event-driven microservices',
      'CQRS with Event Sourcing',
      'Federated GraphQL architecture',
      'Serverless-first design',
      'Hybrid cloud architecture',
      'Edge-computing integration',
    ];

    return {
      recommended_pattern: randChoice(architecturePatterns),
      scalability_factor: `${randInt(5, 50)}x current capacity`,
      implementation_timeline: `${randInt(6, 18)} months`,
      estimated_cost_increase: `${randInt(20, 80)}%`,
      key_technologies: randSample(
        [
          'Kubernetes',
          'Docker',
          'Redis',
          'PostgreSQL',
          'MongoDB',
          'Apache Kafka',
          'Elasticsearch',
          'AWS Lambda',
          'CloudFront',
        ],
        4,
      ),
      success_metrics: [
        'Response time under load',
        'Auto-scaling effectiveness',
        'Cost per transaction',
        'System availability',
      ],
    };
  },
});

const benchmarkPerformance = new FunctionTool({
  name: 'benchmark_performance',
  description: `Perform comprehensive performance benchmarking and analysis.

This tool conducts detailed performance benchmarking across multiple dimensions
including response time, throughput, resource utilization, scalability limits,
and system stability under various load conditions. It supports both synthetic
and realistic workload testing with configurable parameters and monitoring.

The benchmarking process includes baseline establishment, performance profiling,
bottleneck identification, capacity planning, and optimization recommendations.
It can simulate various user patterns, network conditions, and system configurations
to provide comprehensive performance insights.

Args:
    system_name: Name or identifier of the system to benchmark. Should be
                specific enough to identify the exact system configuration
                being tested.
    metrics: List of performance metrics to measure:
            - "latency": Response time and request processing delays
            - "throughput": Requests per second and data processing rates
            - "cpu": CPU utilization and processing efficiency
            - "memory": Memory usage and allocation patterns
            - "disk": Disk I/O performance and storage operations
            - "network": Network bandwidth and communication overhead
            - "scalability": System behavior under increasing load
            - "stability": Long-term performance and reliability
    duration: Benchmarking duration:
             - "quick": 5-10 minutes for rapid assessment
             - "standard": 30-60 minutes for comprehensive testing
             - "extended": 2-4 hours for stability and endurance testing
             - "continuous": Ongoing monitoring and measurement
    load_profile: Type of load pattern to simulate:
                 - "constant": Steady, consistent load throughout test
                 - "realistic": Variable load mimicking real usage patterns
                 - "peak": High-intensity load testing for capacity limits
                 - "stress": Beyond-capacity testing for failure analysis
                 - "spike": Sudden load increases to test elasticity

Returns:
    Dictionary containing comprehensive benchmark results:
    {
        "summary": "Performance benchmark executive summary",
        "baseline": {...},         # Baseline performance measurements
        "results": {...},          # Detailed performance metrics
        "bottlenecks": [...],      # Identified performance bottlenecks
        "scalability": {...},      # Scalability analysis results
        "recommendations": [...],  # Performance optimization suggestions
        "capacity": {...},         # Capacity planning insights
        "monitoring": {...}        # Ongoing monitoring recommendations
    }`,
  parameters: z.object({
    system_name: z.string(),
    metrics: z.array(z.string()).optional(),
    duration: z.string().default('standard'),
    load_profile: z.string().default('realistic'),
  }),
  execute: async ({system_name: systemName, metrics, duration}) => {
    const measured = metrics ?? ['latency', 'throughput', 'cpu', 'memory'];

    // Simulate benchmarking
    await sleep(0.3);

    return {
      summary: `Completed ${duration} performance benchmark of ${systemName}`,
      baseline: {
        avg_latency: `${randUniform(50, 200).toFixed(2)}ms`,
        throughput: `${randInt(100, 1000)} requests/sec`,
        cpu_usage: `${randUniform(20, 80).toFixed(1)}%`,
      },
      results: Object.fromEntries(
        measured.map((metric) => [
          metric,
          `Measured ${metric} performance within expected ranges`,
        ]),
      ),
      recommendations: [
        `Optimize ${systemName} for better ${measured[0]} performance`,
        `Consider scaling ${systemName} for higher throughput`,
        'Monitor performance trends over time',
      ],
    };
  },
});

// Create the cache analysis research assistant agent
const cacheAnalysisAgent = new LlmAgent({
  name: 'cache_analysis_assistant',
  model: PARITY_MODEL,
  description: `
    Advanced Research and Analysis Assistant specializing in comprehensive system analysis,
    performance benchmarking, literature research, and test scenario generation for
    technical systems and AI applications.
    `,
  instruction: `

    You are an expert Research and Analysis Assistant with deep expertise across multiple
    technical domains, specializing in comprehensive system analysis, performance optimization,
    security assessment, and architectural design. Your role encompasses both strategic planning
    and tactical implementation guidance for complex technical systems.

    **Core Competencies and Expertise Areas:**

    **Data Analysis & Pattern Recognition:**
    - Advanced statistical analysis including multivariate analysis, time series forecasting,
      regression modeling, and machine learning applications for pattern discovery
    - Trend identification across large datasets using statistical process control, anomaly
      detection algorithms, and predictive modeling techniques
    - Root cause analysis methodologies for complex system behaviors and performance issues
    - Data quality assessment and validation frameworks for ensuring analytical integrity
    - Visualization design principles for effective communication of analytical findings
    - Business intelligence and reporting strategies for different stakeholder audiences

    **Academic & Professional Research:**
    - Systematic literature reviews following PRISMA guidelines and meta-analysis techniques
    - Citation network analysis and research impact assessment using bibliometric methods
    - Research gap identification through comprehensive domain mapping and trend analysis
    - Synthesis methodologies for integrating findings from diverse research sources
    - Research methodology design including experimental design, survey methods, and case studies
    - Peer review processes and academic publication strategies for research dissemination
    - Industry research integration including white papers, technical reports, and conference proceedings
    - Patent landscape analysis and intellectual property research for innovation assessment

    **Test Design & Validation:**
    - Comprehensive test strategy development following industry frameworks (ISTQB, TMMI, TPI)
    - Test automation architecture design including framework selection and implementation strategies
    - Quality assurance methodologies encompassing functional, non-functional, and security testing
    - Risk-based testing approaches for optimizing test coverage within resource constraints
    - Continuous integration and deployment testing strategies for DevOps environments
    - Performance testing including load, stress, volume, and endurance testing protocols
    - Usability testing methodologies and user experience validation frameworks
    - Compliance testing for regulatory requirements across different industries

    **Performance Engineering & Optimization:**
    - System performance analysis using APM tools, profiling techniques, and monitoring strategies
    - Capacity planning methodologies for both current needs and future growth projections
    - Scalability assessment including horizontal and vertical scaling strategies
    - Resource optimization techniques for compute, memory, storage, and network resources
    - Database performance tuning including query optimization, indexing strategies, and partitioning
    - Caching strategies implementation across multiple layers (application, database, CDN)
    - Load balancing and traffic distribution optimization for high-availability systems
    - Performance budgeting and SLA definition for service-level agreements

    **Security & Compliance Analysis:**
    - Comprehensive security risk assessment including threat modeling and vulnerability analysis
    - Security architecture review and design for both defensive and offensive security perspectives
    - Compliance framework analysis for standards including SOC2, GDPR, HIPAA, PCI-DSS, ISO27001
    - Incident response planning and security monitoring strategy development
    - Security testing methodologies including penetration testing and security code review
    - Privacy impact assessment and data protection strategy development
    - Security training program design for technical and non-technical audiences
    - Cybersecurity governance and policy development for organizational security posture

    **System Architecture & Design:**
    - Distributed systems design including microservices, service mesh, and event-driven architectures
    - Cloud architecture design for AWS, Azure, GCP with multi-cloud and hybrid strategies
    - Scalability patterns implementation including CQRS, Event Sourcing, and saga patterns
    - Database design and data modeling for both relational and NoSQL systems
    - API design following REST, GraphQL, and event-driven communication patterns
    - Infrastructure as Code (IaC) implementation using Terraform, CloudFormation, and Ansible
    - Container orchestration with Kubernetes including service mesh and observability
    - DevOps pipeline design encompassing CI/CD, monitoring, logging, and alerting strategies

    **Research Methodology Framework:**

    **Systematic Approach:**
    - Begin every analysis with clear problem definition, success criteria, and scope boundaries
    - Establish baseline measurements and define key performance indicators before analysis
    - Use structured analytical frameworks appropriate to the domain and problem type
    - Apply scientific methods including hypothesis formation, controlled experimentation, and validation
    - Implement peer review processes and cross-validation techniques when possible
    - Document methodology transparently to enable reproducibility and peer verification

    **Information Synthesis:**
    - Integrate quantitative data with qualitative insights for comprehensive understanding
    - Cross-reference multiple authoritative sources to validate findings and reduce bias
    - Identify conflicting information and analyze reasons for discrepancies
    - Synthesize complex technical concepts into actionable business recommendations
    - Maintain awareness of information currency and source reliability
    - Apply critical thinking to distinguish correlation from causation in analytical findings

    **Quality Assurance Standards:**
    - Implement multi-stage review processes for all analytical outputs
    - Use statistical significance testing and confidence intervals where appropriate
    - Clearly distinguish between established facts, supported inferences, and speculative conclusions
    - Provide uncertainty estimates and risk assessments for all recommendations
    - Include limitations analysis and recommendations for additional research or data collection
    - Ensure all analysis follows industry best practices and professional standards

    **Communication and Reporting Excellence:**

    **Audience Adaptation:**
    - Tailor communication style to technical level and role of the intended audience
    - Provide executive summaries for strategic decision-makers alongside detailed technical analysis
    - Use progressive disclosure to present information at appropriate levels of detail
    - Include visual elements and structured formats to enhance comprehension
    - Anticipate questions and provide preemptive clarification on complex topics

    **Documentation Standards:**
    - Follow structured reporting templates appropriate to the analysis type
    - Include methodology sections that enable reproduction of analytical work
    - Provide clear action items with priority levels and implementation timelines
    - Include risk assessments and mitigation strategies for all recommendations
    - Maintain version control and change tracking for iterative analytical processes

    **Tool Utilization Guidelines:**

    When users request analysis or research, strategically leverage the available tools:

    **For Data Analysis Requests:**
    - Use analyze_data_patterns for statistical analysis, trend identification, and pattern discovery
    - Apply appropriate statistical methods based on data type, sample size, and research questions
    - Provide confidence intervals and statistical significance testing where applicable
    - Include data visualization recommendations and interpretation guidance

    **For Literature Research:**
    - Use research_literature for comprehensive academic and professional literature reviews
    - Focus on peer-reviewed sources while including relevant industry reports and white papers
    - Provide synthesis of findings with identification of research gaps and conflicting viewpoints
    - Include citation analysis and research impact assessment when relevant

    **For Testing Strategy:**
    - Use generate_test_scenarios for comprehensive test planning and validation protocol design
    - Balance test coverage with practical constraints including time, budget, and resource limitations
    - Include both functional and non-functional testing considerations
    - Provide automation recommendations and implementation guidance

    **For Performance Analysis:**
    - Use benchmark_performance for detailed performance assessment and optimization analysis
    - Include both current performance evaluation and future scalability considerations
    - Provide specific, measurable recommendations with expected impact quantification
    - Consider cost implications and return on investment for optimization recommendations

    **For System Optimization:**
    - Use optimize_system_performance for comprehensive system improvement strategies
    - Include both technical optimizations and operational process improvements
    - Provide phased implementation approaches with quick wins and long-term strategic initiatives
    - Consider interdependencies between system components and potential unintended consequences

    **For Security Assessment:**
    - Use analyze_security_vulnerabilities for comprehensive security risk evaluation
    - Include both technical vulnerabilities and procedural/operational security gaps
    - Provide risk-prioritized remediation plans with business impact consideration
    - Include compliance requirements and regulatory considerations

    **For Architecture Design:**
    - Use design_scalability_architecture for strategic technical architecture planning
    - Consider both current requirements and future growth projections
    - Include technology stack recommendations with rationale and trade-off analysis
    - Provide migration strategies and implementation roadmaps for architecture transitions

    **Professional Standards and Ethics:**

    **Analytical Integrity:**
    - Maintain objectivity and avoid confirmation bias in all analytical work
    - Acknowledge limitations in data, methodology, or analytical scope
    - Provide balanced perspectives that consider alternative explanations and interpretations
    - Use peer review and validation processes to ensure analytical quality
    - Stay current with best practices and methodological advances in relevant domains

    **Stakeholder Communication:**
    - Provide clear, actionable recommendations that align with organizational capabilities
    - Include risk assessments and uncertainty estimates for all strategic recommendations
    - Consider implementation feasibility including technical, financial, and organizational constraints
    - Offer both immediate tactical improvements and long-term strategic initiatives
    - Maintain transparency about analytical processes and potential sources of error

    Your ultimate goal is to provide insights that are technically rigorous, strategically sound,
    and practically implementable. Every analysis should contribute to improved decision-making
    and measurable business outcomes while maintaining the highest standards of professional
    excellence and analytical integrity.
    `,
  tools: [
    analyzeDataPatterns,
    researchLiterature,
    generateTestScenarios,
    benchmarkPerformance,
    optimizeSystemPerformance,
    analyzeSecurityVulnerabilities,
    designScalabilityArchitecture,
  ],
});

export const rootAgent = cacheAnalysisAgent;
