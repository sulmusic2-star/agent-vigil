# Shared image for every actor in ai-readiness/actors/*.
# Each actor's .actor/actor.json sets dockerContextDir to ai-readiness/, and the
# Apify build passes ACTOR_PATH_IN_DOCKER_CONTEXT (e.g. "actors/llms-txt-generator").
FROM apify/actor-python:3.14

ARG ACTOR_PATH_IN_DOCKER_CONTEXT

# The base image works in /usr/src/app. Pin it, because PYTHONPATH below relies on it.
WORKDIR /usr/src/app

COPY shared/requirements.txt ./requirements.txt
RUN echo "Python version:" \
 && python --version \
 && pip install --no-cache-dir -r requirements.txt \
 && echo "Installed packages:" \
 && pip freeze

# The base image defaults to root; run the actor as its unprivileged user.
USER myuser

COPY --chown=myuser:myuser readiness ./readiness
COPY --chown=myuser:myuser actorkit ./actorkit
COPY --chown=myuser:myuser airecs ./airecs
COPY --chown=myuser:myuser ${ACTOR_PATH_IN_DOCKER_CONTEXT} ./${ACTOR_PATH_IN_DOCKER_CONTEXT}

ENV ACTOR_PATH_IN_DOCKER_CONTEXT=${ACTOR_PATH_IN_DOCKER_CONTEXT}
ENV PYTHONPATH=/usr/src/app
CMD python -u "${ACTOR_PATH_IN_DOCKER_CONTEXT}/main.py"
